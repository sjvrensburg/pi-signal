/**
 * pi-signal — Signal chat for the EVO-X3, on the pi SDK. docs/13 Phase D in halo-prep.
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
import { spawn } from "node:child_process";
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
const MODELS = {
	terse: ["local-ornith", "ornith-1.5-35b-a3b"], // :8092, two slots, terse template (default)
	prose: ["local-ornith35", "ornith-1.5-35b-a3b"], // :8088, one slot shared with Open Notebook
} as const;
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
				"`at` (a systemd calendar time such as '2026-09-25 08:00' or 'Mon 09:00'). Survives restarts.",
			parameters: Type.Object({
				text: Type.String({ description: "The reminder text." }),
				in: Type.Optional(Type.String({ description: "Delay, e.g. 20m, 2h, 1d." })),
				at: Type.Optional(Type.String({ description: "systemd OnCalendar time, local timezone." })),
			}),
			async execute(_id, p) {
				// A transient systemd timer, not a timer held in this process: it survives the bot
				// restarting. This replaces Hermes's reminder-cron skill (18 calls into `hermes cron`).
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
				const tag = `voice-${Date.now()}`;
				const lease = join(homedir(), "Projects/halo-prep/scripts/vibevoice-lease.sh");
				const wav = join(STATE, "out", `${tag}.wav`);
				await sh("bash", [lease, "acquire", tag]);
				try {
					const r = await fetch("http://127.0.0.1:8087/v1/audio/speech", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							model: "/home/stefan/models/vibevoice-1.5b", // a literal path, not a name
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
	const chat: Chat = { key, to, session, modelName };
	// Deliver every finished assistant turn as it lands, so a follow-up queued mid-run gets its
	// own reply instead of only the last one surviving.
	session.subscribe((ev: any) => {
		if (ev.type !== "message_end" || ev.message?.role !== "assistant") return;
		const m = ev.message;
		if (m.stopReason === "toolUse") return;
		const body = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
		const msg = m.stopReason === "error" ? `⚠️ ${m.errorMessage ?? "model error"}` : body;
		if (msg && m.stopReason !== "aborted") send(to, msg).catch((e) => log("reply failed:", e.message));
	});
	chats.set(key, chat);
	return chat;
}

async function chatFor(key: string, to: string) {
	return chats.get(key) ?? (await openChat(key, to));
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
				return send(chat.to, `Model: ${chat.modelName}. Use /model terse (:8092) or /model prose (:8088).`);
			const [prov, id] = MODELS[arg];
			await chat.session.setModel(runtime.getModel(prov, id)!);
			chat.modelName = arg;
			return send(chat.to, `Now using ${arg}.`);
		}
		default:
			return send(chat.to, "Commands: /new (fresh conversation), /stop (abort), /model terse|prose.");
	}
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

	const prompt =
		textIn +
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
