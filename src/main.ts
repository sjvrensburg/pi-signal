/**
 * pi-signal — Signal chat with a pi agent, on the pi SDK. Written for the EVO-X3 (halo-prep
 * docs/13 Phase D); every box-specific value below is an env var with that box's value as default.
 *
 * signal-cli daemon (SSE events, JSON-RPC sends) <-> one persistent pi session per chat.
 * Replaces Hermes's Signal gateway, which was removed on 2026-09-24.
 *
 * NOTE TO SELF IS THE CHAT. The operator talks to the box in Signal's "Note to Self" on the
 * box's own account (signal-cli is a linked device, id 2). Those arrive as
 * syncMessage.sentMessage with destination = our account, not as dataMessage. Hermes's adapter
 * (gateway/platforms/signal.py, _unwrap_sync_message) did the same unwrap; it is mirrored here.
 *
 * NO ECHO LOOP. Measured 2026-09-24: sends made by this daemon (the bot's replies and the
 * pi-job timers' signal-send messages alike) do NOT come back on the event stream. Two guards
 * stay anyway, because a loop here would be an agent talking to itself on the operator's phone:
 * sync messages from signal-cli's own device are dropped, and so are timestamps we sent.
 *
 * NOTHING ELSE MAY RECEIVE. Only one consumer may read the daemon's events or messages get
 * split between agents. Hermes was that consumer until 2026-09-24; this is now.
 */
import { spawn, execFile } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	defineTool,
	ModelRuntime,
	SessionManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";

// ── config ──────────────────────────────────────────────────────────────────────────────────
const ACCOUNT = process.env.SIGNAL_ACCOUNT ?? "";
if (!ACCOUNT) throw new Error("SIGNAL_ACCOUNT unset (EnvironmentFile=%h/.config/signal-send/env)");
const RPC = process.env.SIGNAL_RPC_BASE ?? "http://127.0.0.1:8081";
const OWN_DEVICE = Number(process.env.PI_SIGNAL_OWN_DEVICE ?? "2"); // signal-cli's device id
// Direct messages from these numbers are also answered. Note to Self is always allowed.
const ALLOW = new Set((process.env.PI_SIGNAL_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const STATE = join(homedir(), ".local/state/pi-signal");
const WORK = join(STATE, "work"); // cwd for sessions; its AGENTS.md is the bot's standing instructions
// Two models, as pi "provider/id". The defaults are the EVO-X3's: terse = :8092, two slots,
// Gemma-4-E4B-it since 2026-10-11 (CyberTiel 09-27 to 10-11, Ornith before); prose = :8088,
// one slot shared with Open Notebook.
const providerModel = (v: string) => {
	const i = v.indexOf("/");
	if (i < 1) throw new Error(`model "${v}" is not provider/id`);
	return [v.slice(0, i), v.slice(i + 1)] as const;
};
const MODELS = {
	terse: providerModel(process.env.PI_SIGNAL_TERSE_MODEL ?? "local-ornith/gemma4-e4b"),
	prose: providerModel(process.env.PI_SIGNAL_PROSE_MODEL ?? "local-ornith35/ornith-1.5-35b-a3b"),
};
// voice_message: an OpenAI-style /v1/audio/speech server and a lease helper that starts it on
// demand and stops it when the last user is done (halo-prep scripts/vibevoice-lease.sh). No
// helper file = the tool reports that voice is unavailable here.
const TTS_URL = process.env.PI_SIGNAL_TTS_URL ?? "http://127.0.0.1:8087/v1/audio/speech";
const TTS_MODEL = process.env.PI_SIGNAL_TTS_MODEL ?? join(homedir(), "models/vibevoice-1.5b"); // a literal path, not a name
const TTS_LEASE = process.env.PI_SIGNAL_TTS_LEASE ?? join(homedir(), "Projects/halo-prep/scripts/vibevoice-lease.sh");
const MAX_CHARS = 7900; // Hermes split at 8000 (MAX_MESSAGE_LENGTH); signal-send does the same
for (const d of [STATE, WORK, join(STATE, "sessions"), join(STATE, "attachments"), join(STATE, "out")])
	mkdirSync(d, { recursive: true });

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// ── signal-cli JSON-RPC ─────────────────────────────────────────────────────────────────────
const sentTimestamps = new Set<number>();

async function rpc(method: string, params: Record<string, unknown>): Promise<any> {
	const r = await fetch(`${RPC}/api/v1/rpc`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params: { account: ACCOUNT, ...params } }),
	});
	const j: any = await r.json();
	if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 300)}`);
	return j.result;
}

function chunks(text: string): string[] {
	if (text.length <= MAX_CHARS) return [text];
	const out: string[] = [];
	let cur = "";
	for (const line of text.split(/(?<=\n)/)) {
		if (cur.length + line.length > MAX_CHARS && cur) { out.push(cur); cur = ""; }
		cur += line.length > MAX_CHARS ? line.slice(0, MAX_CHARS) : line;
	}
	if (cur) out.push(cur);
	return out.map((c, i) => `${c.trimEnd()}\n(${i + 1}/${out.length})`);
}

async function send(to: string, text: string, attachments: string[] = []): Promise<void> {
	const parts = text ? chunks(text) : [""];
	for (const [i, message] of parts.entries()) {
		const res = await rpc("send", {
			recipient: [to],
			message,
			...(i === 0 && attachments.length ? { attachments } : {}),
		});
		if (res?.timestamp) sentTimestamps.add(res.timestamp);
		const bad = (res?.results ?? []).filter((r: any) => r.type && r.type !== "SUCCESS");
		if (bad.length) throw new Error(`send failed: ${bad.map((r: any) => r.type).join(",")}`);
	}
}

// ── per-chat sessions ───────────────────────────────────────────────────────────────────────
interface Chat {
	key: string;
	to: string;
	session: AgentSession;
	modelName: keyof typeof MODELS;
}
const chats = new Map<string, Chat>();

/**
 * ONE SESSION PER LOCAL DAY, AND EVERY MESSAGE CARRIES ITS TIME. Until 2026-10-09 a chat was one
 * session forever, and nothing in it said what day it was. On 2026-10-08 "weather for my city
 * today" was answered from the 2026-10-07 tool output still in context ("I already have it"),
 * and on 2026-09-29 the model took 2026-09-26 for today from an old forecast. The timestamp lets
 * the model see time has passed; the daily rollover keeps yesterday's tool output out of reach.
 * Continuity across days comes from @pify/memory and pi-session-search, which both run on
 * session_start. /new still forces a fresh session mid-day.
 */
const localDay = (d: Date) => d.toLocaleDateString("en-CA"); // YYYY-MM-DD in the service's TZ
const stamp = (d: Date) =>
	d.toLocaleString("en-GB", {
		weekday: "short", year: "numeric", month: "short", day: "numeric",
		hour: "2-digit", minute: "2-digit", timeZoneName: "short",
	});
function lastActivity(s: AgentSession): Date | null {
	const e = s.sessionManager.getEntries();
	const ts = e.length ? (e[e.length - 1] as any).timestamp : undefined;
	return ts ? new Date(ts) : null;
}
let runtime: ModelRuntime;

function sh(cmd: string, args: string[], input?: string): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		const p = spawn(cmd, args, { env: process.env });
		let out = "";
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (out += d));
		p.on("close", (code) => resolve({ code: code ?? 1, out }));
		if (input !== undefined) p.stdin.end(input);
	});
}

function toolsFor(to: string) {
	const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
	return [
		defineTool({
			name: "signal_send_file",
			label: "Send file",
			description: "Send a file (document, image, audio) to the user on Signal, with an optional caption.",
			parameters: Type.Object({
				path: Type.String({ description: "Absolute path of the file to send." }),
				caption: Type.Optional(Type.String({ description: "Text to send with the file." })),
			}),
			async execute(_id, p) {
				if (!existsSync(p.path)) return text(`No such file: ${p.path}`);
				await send(to, p.caption ?? "", [p.path]);
				return text(`Sent ${basename(p.path)}.`);
			},
		}),
		defineTool({
			name: "remind",
			label: "Remind",
			description:
				"Schedule a Signal reminder to the user. Give EITHER `in` (a delay such as 20m, 2h, 1d) OR " +
				"`at` (a systemd calendar time such as '2026-09-25 08:00' or 'Mon 09:00'). Survives a bot " +
				"restart but NOT a reboot of the box: say so when scheduling one more than a few hours out.",
			parameters: Type.Object({
				text: Type.String({ description: "The reminder text." }),
				in: Type.Optional(Type.String({ description: "Delay, e.g. 20m, 2h, 1d." })),
				at: Type.Optional(Type.String({ description: "systemd OnCalendar time, local timezone." })),
			}),
			async execute(_id, p) {
				// A transient systemd timer, not a timer held in this process: it survives the bot
				// restarting. Transient units live in /run, so a reboot drops it silently. This replaces Hermes's reminder-cron skill (18 calls into `hermes cron`).
				if (!!p.in === !!p.at) return text("Give exactly one of `in` or `at`.");
				const when = p.in ? [`--on-active=${p.in}`] : [`--on-calendar=${p.at}`];
				const unit = `pi-remind-${Date.now()}`;
				const r = await sh("systemd-run", [
					"--user", "--collect", `--unit=${unit}`, ...when, "--timer-property=AccuracySec=1s",
					`--setenv=PATH=${homedir()}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
					"signal-send", "--to", to, `⏰ ${p.text}`,
				]);
				if (r.code !== 0) return text(`Could not schedule: ${r.out.trim()}`);
				const next = await sh("systemctl", ["--user", "list-timers", `${unit}.timer`, "--no-legend"]);
				return text(`Scheduled (${unit}): ${next.out.trim().split(/\s{2,}/).slice(0, 2).join(" ")}`);
			},
		}),
		defineTool({
			name: "voice_message",
			label: "Voice message",
			description:
				"Speak text aloud with VibeVoice and send it to the user as a Signal voice clip. " +
				"Voices: en-Alice_woman (default), en-Frank_man, en-Carter_man, en-Maya_woman.",
			parameters: Type.Object({
				text: Type.String({ description: "Exactly what to say." }),
				voice: Type.Optional(Type.String()),
			}),
			async execute(_id, p) {
				// vibevoice-api is on demand: the lease helper starts it, refcounts it, and stops it
				// again (halo-prep scripts/vibevoice-lease.sh). Never a bare systemctl stop.
				if (!existsSync(TTS_LEASE)) return text(`Voice is not set up here (no ${TTS_LEASE}).`);
				const tag = `voice-${Date.now()}`;
				const lease = TTS_LEASE;
				const wav = join(STATE, "out", `${tag}.wav`);
				await sh("bash", [lease, "acquire", tag]);
				try {
					const r = await fetch(TTS_URL, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							model: TTS_MODEL,
							voice: p.voice ?? "en-Alice_woman",
							input: p.text,
							response_format: "wav",
						}),
					});
					if (!r.ok) return text(`TTS failed: HTTP ${r.status}`);
					writeFileSync(wav, Buffer.from(await r.arrayBuffer()));
					await send(to, "", [wav]);
					return text("Voice message sent.");
				} finally {
					await sh("bash", [lease, "release", tag]);
				}
			},
		}),
	];
}

async function openChat(key: string, to: string, fresh = false, modelName: keyof typeof MODELS = "terse") {
	const dir = join(STATE, "sessions", key);
	mkdirSync(dir, { recursive: true });
	const [prov, id] = MODELS[modelName];
	const { session } = await createAgentSession({
		cwd: WORK,
		modelRuntime: runtime,
		model: runtime.getModel(prov, id),
		thinkingLevel: "medium",
		sessionManager: fresh ? SessionManager.create(WORK, dir) : SessionManager.continueRecent(WORK, dir),
		customTools: toolsFor(to),
	});
	// createAgentSession alone never emits session_start: pi only fires it from bindExtensions().
	// Without this call the extensions that set up there never do (found 2026-09-26): the memory
	// snapshot (@pify/memory), the session-search index, pi-condense's config, the judge's
	// session id. pi-web calls it too. No uiContext: headless, so extensions see hasUI=false.
	await session.bindExtensions({ onError: (e: any) => log("extension error:", e?.error?.message ?? e?.error ?? e) });
	const chat: Chat = { key, to, session, modelName };
	// Deliver every finished assistant turn as it lands, so a follow-up queued mid-run gets its
	// own reply instead of only the last one surviving.
	session.subscribe((ev: any) => {
		if (ev.type !== "message_end" || ev.message?.role !== "assistant") return;
		const m = ev.message;
		const body = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
		// Text alongside a tool call is sent too: it is how the model says "converting the
		// PDF, ~5 min" before a long step, and without it the phone hears nothing until the
		// whole turn ends. A tool-call message with no text (the usual case) sends nothing.
		if (m.stopReason === "toolUse" && !body) return;
		const msg = m.stopReason === "error" ? `⚠️ ${m.errorMessage ?? "model error"}` : body;
		// Log the send too: without it a delivered reply leaves no trace in the journal.
		if (msg && m.stopReason !== "aborted")
			send(to, msg)
				.then(() => log(`out ${key}: ${msg.length} chars`))
				.catch((e) => log("reply failed:", e.message));
	});
	chats.set(key, chat);
	return chat;
}

async function chatFor(key: string, to: string) {
	const chat = chats.get(key) ?? (await openChat(key, to));
	const last = lastActivity(chat.session);
	// Never roll over mid-run: a follow-up to a still-running turn belongs to it.
	if (!last || chat.session.isStreaming || localDay(last) === localDay(new Date())) return chat;
	log(`${key}: new day, fresh session (last activity ${last.toISOString()})`);
	chat.session.dispose();
	return openChat(key, to, true, chat.modelName);
}

// ── inbound ─────────────────────────────────────────────────────────────────────────────────
async function saveAttachment(a: any): Promise<string | null> {
	try {
		const res = await rpc("getAttachment", { id: a.id });
		const data = typeof res === "string" ? res : res?.data;
		if (!data) return null;
		const name = (a.filename as string | undefined)?.replace(/[^\w.-]/g, "_") ?? a.id;
		const path = join(STATE, "attachments", `${Date.now()}-${name}`);
		writeFileSync(path, Buffer.from(data, "base64"));
		return path;
	} catch (e: any) {
		log("attachment failed:", e.message);
		return null;
	}
}

async function handleCommand(chat: Chat, cmd: string, arg: string) {
	switch (cmd) {
		case "/new":
			await chat.session.abort();
			chat.session.dispose();
			await openChat(chat.key, chat.to, true, chat.modelName);
			return send(chat.to, "Started a new conversation.");
		case "/stop":
			await chat.session.abort();
			return send(chat.to, "Stopped.");
		case "/model": {
			if (arg !== "terse" && arg !== "prose")
				return send(chat.to, `Model: ${chat.modelName}. Use /model terse (${MODELS.terse.join("/")}) or /model prose (${MODELS.prose.join("/")}).`);
			const [prov, id] = MODELS[arg];
			await chat.session.setModel(runtime.getModel(prov, id)!);
			chat.modelName = arg;
			return send(chat.to, `Now using ${arg}.`);
		}
		default:
			return send(chat.to, "Commands: /new (fresh conversation), /stop (abort), /model terse|prose.");
	}
}


/**
 * SHORTLIST REFERENCES ARE RESOLVED HERE, NOT BY THE MODEL. The daily podcast-topic-discovery
 * shortlist goes out through signal-send, outside this session, so "topic #2" in a long-lived
 * chat gets resolved from whichever older list is still in context: wrong episode on 2026-10-01
 * and again on 2026-10-02, after a skill instruction to run resolve_topic.py was ignored. So the
 * script runs before the model sees the message. Success: its output is injected into the
 * prompt. Failure (stale, no such item, ambiguous): the operator is asked directly and the
 * model is never invoked, so it cannot fall back to context.
 */
const RESOLVE = join(homedir(), ".pi/agent/skills/open-notebook-podcast/scripts/resolve_topic.py");
const TOPIC_REF = /^(?:\W*(?:generate|make|do|create|run|start)?\W*(?:the\s+|a\s+)?(?:podcast|episode)?\W*(?:on|for|about|from|based on)?\W*(?:the\s+)?(?:topic\s*)?#?\s*(\d{1,2})\W*(?:please|thanks|now)?\W*)$/i;
function resolveTopicRef(text: string): Promise<{ ok: boolean; out: string } | null> {
	const n = text.length <= 80 && /\d/.test(text) ? text.match(TOPIC_REF)?.[1] : undefined;
	// Needs "topic", "#" or podcast/episode wording, or be a bare number; "I have 3 questions" no.
	if (!n || !(/#|topic|podcast|episode/i.test(text) || /^\W*\d{1,2}\W*$/.test(text))) return Promise.resolve(null);
	return new Promise((res) =>
		execFile("python3", [RESOLVE, n], { timeout: 15_000 }, (err, stdout, stderr) => {
			// A bare number with no usable shortlist is probably not about podcasts: stay out of it.
			if (err && /^\W*\d{1,2}\W*$/.test(text)) return res(null);
			res({ ok: !err, out: (err ? stderr || String(err) : stdout).trim() });
		}),
	);
}

async function handleEnvelope(env: any) {
	let dm: any;
	let key: string;
	let to: string;
	if (env.syncMessage) {
		const sent = env.syncMessage.sentMessage;
		const dest = sent?.destinationNumber ?? sent?.destination;
		if (!sent || dest !== ACCOUNT || sent.groupInfo) return; // receipts, typing, other chats
		if (env.sourceDevice === OWN_DEVICE || sentTimestamps.delete(sent.timestamp)) return; // our own
		dm = sent;
		key = "self";
		to = ACCOUNT;
	} else {
		dm = env.dataMessage ?? env.editMessage?.dataMessage;
		const from = env.sourceNumber ?? env.source;
		if (!dm || dm.groupInfo || !ALLOW.has(from)) return; // everyone else is dropped unread
		key = from.replace(/\W/g, "");
		to = from;
	}
	const textIn: string = (dm.message ?? "").trim();
	const paths = (await Promise.all((dm.attachments ?? []).map(saveAttachment))).filter(Boolean) as string[];
	if (!textIn && !paths.length) return;
	log(`in ${key}: ${textIn.slice(0, 60)}${paths.length ? ` +${paths.length} file(s)` : ""}`);

	const chat = await chatFor(key, to);
	const m = textIn.match(/^(\/\w+)\s*(.*)$/s);
	if (m && ["/new", "/stop", "/model", "/help"].includes(m[1])) return handleCommand(chat, m[1], m[2].trim());

	let resolved = "";
	if (!paths.length) {
		const r = await resolveTopicRef(textIn);
		if (r && !r.ok) {
			log(`shortlist ref refused: ${r.out.slice(0, 120)}`);
			return send(to, `Can't resolve that against a current shortlist: ${r.out}\nWhich topic do you mean? Send the title.`).catch(() => {});
		}
		if (r) {
			log(`shortlist ref resolved: ${r.out.split("\n")[1] ?? ""}`);
			resolved =
				"\n\n[pi-signal resolved this shortlist reference from the newest shortlist file. Use ONLY the item below; " +
				"ignore any other list in your context. State the title and shortlist date in your first line. " +
				"The pick is already logged; do not run resolve_topic.py or pref_log.py again.]\n" + r.out;
		}
	}
	const prompt =
		`[${stamp(new Date())}] ` + textIn + resolved +
		(paths.length ? `\n\n[Attached file(s), saved locally: ${paths.join(", ")}]` : "");
	if (chat.session.isStreaming) {
		await chat.session.followUp(prompt);
		return;
	}
	// Typing indicator while the run lasts; Signal clears it on its own after ~15 s.
	const typing = setInterval(() => rpc("sendTyping", { recipient: [to] }).catch(() => {}), 10_000);
	rpc("sendTyping", { recipient: [to] }).catch(() => {});
	try {
		await chat.session.prompt(prompt);
	} catch (e: any) {
		await send(to, `⚠️ ${e.message}`).catch(() => {});
	} finally {
		clearInterval(typing);
		rpc("sendTyping", { recipient: [to], stop: true }).catch(() => {});
	}
}

async function listen() {
	let backoff = 2_000;
	for (;;) {
		try {
			const r = await fetch(`${RPC}/api/v1/events?account=${encodeURIComponent(ACCOUNT)}`, {
				headers: { Accept: "text/event-stream" },
			});
			if (!r.ok || !r.body) throw new Error(`events: HTTP ${r.status}`);
			log("connected to signal-cli events");
			backoff = 2_000;
			const dec = new TextDecoder();
			let buf = "";
			for await (const chunk of r.body as any) {
				buf += dec.decode(chunk, { stream: true });
				let i: number;
				while ((i = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, i).trim();
					buf = buf.slice(i + 1);
					if (!line.startsWith("data:")) continue;
					try {
						const ev = JSON.parse(line.slice(5));
						// Not awaited: a long agent run must not stall the event stream.
						handleEnvelope(ev.envelope ?? ev).catch((e) => log("handler error:", e.message));
					} catch {
						/* keepalive or partial line */
					}
				}
			}
			throw new Error("event stream ended");
		} catch (e: any) {
			log(`${e.message}; reconnecting in ${backoff / 1000}s`);
			await new Promise((res) => setTimeout(res, backoff));
			backoff = Math.min(backoff * 2, 60_000);
		}
	}
}

runtime = await ModelRuntime.create();
if (!existsSync(join(WORK, "AGENTS.md"))) log(`warning: ${WORK}/AGENTS.md missing — no standing instructions`);
await listen();
