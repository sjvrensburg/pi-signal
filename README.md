# pi-signal

Chat with a [pi](https://github.com/earendil-works/pi) agent over Signal. A small daemon sits
between `signal-cli` (its SSE event stream and JSON-RPC sends) and the pi SDK: one pi session
per chat, with the machine's shell and a few Signal-specific tools.

Written for the EVO-X3 home AI box, where it replaced Hermes's Signal gateway on 2026-09-24
(design: `halo-prep/docs/13-pi.md` Phase D; unit: `halo-prep/config/pi-signal.service`). Every
value specific to that box is an environment variable whose default is that box's value.

- **Chat:** Signal's Note to Self on the machine's own account (`signal-cli` is a linked
  device). Direct messages from numbers in `PI_SIGNAL_ALLOW` are answered too; everything else
  is dropped unread.
- **Sessions:** one pi session per chat per local day, under
  `~/.local/state/pi-signal/sessions/`. Every message is stamped with its local time. Both
  since 2026-10-09: a session that ran for two weeks answered "weather today" from the previous
  day's tool output. Continuity across days comes from pi memory/session-search extensions,
  which hook `session_start` (the daemon calls `bindExtensions()` so they get it).
- **Commands:** `/new` (fresh session now), `/stop`, `/model terse|prose`, `/help`.
- **Tools:** pi's `read`, `bash`, `edit`, `write`, plus `signal_send_file`, `remind` (a
  transient systemd timer that calls `signal-send`; lost on reboot) and `voice_message` (TTS
  behind an on-demand lease helper).
- **Podcast shortlist references** ("topic #3") are resolved by a script before the model sees
  the message, so an old list in context cannot win. That path is EVO-X3-specific and is a
  no-op where the resolver is missing.
- **Standing instructions:** `AGENTS.md` in the sessions' cwd, `~/.local/state/pi-signal/work/`.
  Start from `AGENTS.example.md` and add the machine's services and skills.

## Configuration

| Variable | Default | |
|---|---|---|
| `SIGNAL_ACCOUNT` | (required) | The account's number. On the EVO-X3, from `~/.config/signal-send/env`. |
| `SIGNAL_RPC_BASE` | `http://127.0.0.1:8081` | `signal-cli daemon --http` |
| `PI_SIGNAL_OWN_DEVICE` | `2` | signal-cli's device id; its own sync messages are dropped |
| `PI_SIGNAL_ALLOW` | empty | Comma-separated numbers allowed to DM |
| `PI_SIGNAL_TERSE_MODEL` | `local-ornith/cybertiel-coder-35b-a3b` | pi `provider/id`, the default model |
| `PI_SIGNAL_PROSE_MODEL` | `local-ornith35/ornith-1.5-35b-a3b` | `/model prose` |
| `PI_SIGNAL_TTS_URL` | `http://127.0.0.1:8087/v1/audio/speech` | OpenAI-style speech endpoint |
| `PI_SIGNAL_TTS_MODEL` | `~/models/vibevoice-1.5b` | The `model` field the TTS server expects |
| `PI_SIGNAL_TTS_LEASE` | `~/Projects/halo-prep/scripts/vibevoice-lease.sh` | `acquire`/`release <tag>`; missing = voice off |

**Only one process may read signal-cli's events**, or messages get split between consumers.

Run: `npm install`, then `npm start`. Typecheck: `npm run check`.
