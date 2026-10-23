# Design notes

Decisions that are not obvious from the code, and the reasoning behind them.

## The server binds loopback only

`cmd/termd` defaults to `--host 127.0.0.1`. This is deliberate, not a default
someone forgot to change:

* The API can open SSH sessions with stored credentials. Exposing it on a LAN
  means anyone on the same Wi-Fi owns every server in the host list.
* There is no per-user auth beyond one device password, so there is no way to
  grant a colleague access and revoke it later.
* On Android the WebView is the only client and it talks to `127.0.0.1`.

If remote access is ever wanted, it should be an explicit, documented flag with
a real auth story — not a default.

## Sessions outlive their WebSocket

A terminal session is a PTY plus a scrollback ring buffer. When the socket drops
(phone sleeps, Wi-Fi changes, server hiccup) the session stays alive for a grace
period and the client re-attaches to the SAME session id. That is why:

* `terminal.Manager.Open` takes an `onClose` callback — the SSH connection
  reference is handed to the session, not to the WebSocket handler. Releasing it
  with the socket would close the SSH client and kill the PTY we are keeping.
* The re-attach URL carries `session=` and NOT `hostId=`. Sending both would make
  the server open a fresh PTY.
* `session_gone` is a terminal state, not a retryable error: the PTY is gone and
  starting a new one is a user decision.

## The scrollback is bytes, not lines

`terminal.RingBuffer` stores raw bytes and evicts the oldest when full. ANSI
escape sequences routinely straddle two PTY reads; splitting on newlines and
storing strings would corrupt the replay and produce a screen full of literal
escape codes after a reconnect.

## Error frames are all terminal

Every `{"type":"error"}` frame means the server has decided the attempt failed
and is about to close the socket. The client marks the tab failed and stops.
The first version only did that for a subset of codes, so an unrecognised error
left the tab retrying forever against a server that had already given up.

## The key bar's modifiers are a three-state machine

`inactive → (tap) once → (tap) inactive`, and `(long press) locked`.

Ctrl is mostly used for ONE keystroke (^C, ^D, ^L). A plain toggle left it armed
after a single ^C, so the next letters the user typed became control codes. The
two states are also drawn differently (filled vs outlined) because a locked
modifier that looks like a one-shot is how you send ^D by accident.

## Themes are derived, never duplicated

The 36 app themes live in `web/css/variables.css` and `web/src/utils/themeMeta.ts`.
The xterm palette is computed from the app theme's CSS custom properties at
runtime (`utils/terminalTheme.ts`) rather than being a second 36-entry table.
A second table drifts the first time someone adds a theme.

## Secrets live outside the database

`internal/secret` writes one AES-GCM file per (host, kind) under `secrets/`,
with a 32-byte key next to them. The database and the credential store are
separate files on purpose:

* A copied database is not a copied credential store (backup, sync, "move my
  hosts to the new phone").
* Deleting a host removes its secret with a single unlink.

The encryption is NOT a defence against an attacker who can read the app's
private directory — on Android that boundary is the OS sandbox. It raises the bar
for the realistic accident and keeps the files non-greppable.

## Host keys are pinned on first connect

Trust-on-first-use, with the fingerprint reported to the user. A changed key
produces a `409` with both fingerprints and requires an explicit "accept" call
(`POST /api/hosts/{id}/forget-key`). Silently re-pinning would make the pin
pointless: the whole value is noticing that the key changed.

The pin is written BEFORE authentication runs, because the host-key callback
executes first — a user who mistypes a password should not have to re-accept the
key afterwards.

## Port forwards bind loopback

`internal/forward` always listens on `127.0.0.1`. Binding `0.0.0.0` would expose
a remote database (or an internal admin panel) to the entire local network, which
is never what "forward port 5432" means.

## Android ships the server as a `.so`

The Go server is built with `GOOS=android GOARCH=arm64` and placed at
`android/app/src/main/jniLibs/arm64-v8a/libtermd.so`. Two build facts make it
executable, and both fail silently when wrong:

1. It must live in `applicationInfo.nativeLibraryDir` — the app's data directory
   is mounted `noexec` on most devices.
2. The APK must be built with `extractNativeLibs="true"`
   (`jniLibs.useLegacyPackaging = true`). AGP 8 defaults to `false`, which leaves
   the file inside the APK; the path then does not exist and every launch shows
   "server binary missing".

`ServerConfigTest` guards both, plus the loopback address.

## The dock hides on terminal focus, not on keyboard height

On Android the WebView runs `adjustResize`: the layout viewport shrinks, so the
computed keyboard height is 0 BY DESIGN. Gating the key bar or the dock on that
number hides them on exactly the platform that needs them. Both use
`document.activeElement` inside the terminal instead.
