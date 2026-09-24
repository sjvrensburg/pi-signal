# pi-signal

Signal chat for the EVO-X3 on the [pi](https://github.com/earendil-works/pi) SDK. It replaces
Hermes's Signal gateway (removed 2026-09-24). Design and rationale: `~/Projects/halo-prep/docs/13-pi.md`
Phase D. The systemd unit is `halo-prep/config/pi-signal.service`.

- **Chat:** Signal's Note to Self on the box's own account (`SIGNAL_ACCOUNT`, read from
  `~/.config/signal-send/env`). Direct messages from numbers in `PI_SIGNAL_ALLOW` are answered
  too; everything else is dropped unread.
- **Sessions:** one persistent pi session per chat under `~/.local/state/pi-signal/sessions/`.
  The model is `local-ornith` (the 35B on `:8092`); `/model prose` switches to `:8088`.
- **Commands:** `/new`, `/stop`, `/model terse|prose`, `/help`.
- **Tools:** pi's `read`, `bash`, `edit` and `write`, plus `signal_send_file`, `remind`
  (a transient systemd timer that calls `signal-send`) and `voice_message` (VibeVoice through
  halo-prep's lease helper).
- **Standing instructions:** `AGENTS.md`, copied to `~/.local/state/pi-signal/work/`, which is
  the sessions' cwd.

Run: `npm install`, then `npm start`. Typecheck: `npm run check`.
