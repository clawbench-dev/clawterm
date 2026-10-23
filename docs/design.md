# Design notes

Decisions that are not obvious from the code, and the reasoning behind them.

## The app is a client, not a server

An earlier version shipped a Go HTTP server inside the APK and pointed the
WebView at `127.0.0.1`. That was wrong for this product: it is still a
client-server system — a second process, a protocol to keep compatible, a
lifecycle to manage, and a port other apps could reach — for no benefit, since
the only client is the app's own WebView.

The client-only design:

- **SSH** runs in-process via JSch (pure Java, no NDK, no native library).
- **The UI** loads from `assets/web/`, so there is no HTTP origin at all.
- **Data** is SQLite opened directly by the app.
- **Credentials** are AES-GCM files written by the app.

`build.sh` fails the build if the APK contains a native library, because that is
how the server used to get in.

## The bridge has one entry point

```java
@JavascriptInterface public void invoke(String id, String method, String payloadJson)
```

Thirty-five separate `@JavascriptInterface` methods would mean thirty-five magic
strings that must match the TypeScript union, each needing a ProGuard keep rule,
each failing only at runtime as "method not found". One entry point puts the names
in one union (`native/protocol.ts`) and one `switch` (`BridgeDispatcher.handle`).

Three consequences that are load-bearing:

1. **Correlation ids.** Replies arrive through a JS callback, so a pending-promise
   table is mandatory. Two concurrent calls (a terminal opening while the host
   list refreshes) would otherwise settle each other's promises — the classic
   bridge bug that only appears under load.
2. **Timeouts.** A native crash mid-call never calls back. Every request times out
   and drops its table entry; a late reply is ignored rather than delivered to a
   caller that has moved on.
3. **Stable error codes.** The UI branches on `code` and shows `message` only as a
   fallback, so failures can be translated and a JSch wording change cannot change
   behaviour.

## Terminal output is base64

A PTY stream is arbitrary bytes: a multi-byte UTF-8 character split across two
reads is completely normal, and escape sequences contain bytes that are not valid
text. The bridge is a string channel, so the host base64-encodes each chunk and
the view decodes it with `TextDecoder(..., { stream: true })`, which holds an
incomplete sequence instead of emitting U+FFFD.

Text on the wire would produce a replacement character at every chunk boundary —
visible, frequent, and very hard to attribute to the transport.

## Sessions outlive the view

A WebView reload, a rotation, or a phone that slept must not kill the remote
shell. `TerminalManager` holds the channel and a 256 KiB scrollback ring buffer;
`ssh.connect` with an existing `sessionId` re-attaches and replays.

The ring buffer stores BYTES, not lines: ANSI escapes straddle reads, and
splitting on newlines would replay a screen full of literal escape codes.

`session_gone` is terminal — the channel really is dead, and starting a new one is
the user's decision, not something to retry in a loop.

## Refs are counted, connections are pooled

A second tab on the same host opens a channel on the existing session instead of
running the handshake and auth again. `SshConnection.refCount` tracks how many
channels need it; the session closes when the last one does.

A forward also takes a reference: it must keep the connection alive even if every
terminal on that host closes. A one-off SFTP listing does not, so it rides on the
pooled entry without pinning it.

## The key bar's modifiers are a three-state machine

`inactive → (tap) once → (tap) inactive`, and `(long press) locked`.

Ctrl is mostly used for ONE keystroke (^C, ^D, ^L). A plain toggle left it armed
after a single ^C, so the next letters the user typed became control codes. The
two states are drawn differently (filled vs outlined) because a locked modifier
that looks like a one-shot is how you send ^D by accident.

## The dock hides on terminal focus, not on keyboard height

On Android the WebView runs `adjustResize`: the layout viewport shrinks, so the
computed keyboard height is 0 BY DESIGN. Gating the key bar or the dock on that
number hides them on exactly the platform that needs them. Both use
`document.activeElement` inside the terminal instead.

## Host keys are pinned on first connect

Trust-on-first-use, with the fingerprint recorded in SQLite. A changed key fails
the handshake and reports both fingerprints; accepting is an explicit call
(`ssh.acceptHostKey`). Silently re-pinning would make the pin pointless: the whole
value is noticing that the key changed.

The pin is written BEFORE authentication completes, because JSch's host-key
callback runs first — a user who mistypes a password should not have to re-accept
the key afterwards.

A mismatch cannot be thrown out of JSch's callback (JSch turns it into a generic
handshake failure), so it is recorded and turned into a typed error after the dial
fails. Otherwise the UI would show "HostKey has been changed" with no fingerprints
and no way to accept.

## Port forwards bind loopback

`ForwardManager` always listens on `127.0.0.1`. Binding `0.0.0.0` would expose a
remote database (or an internal admin panel) to the entire local network, which is
never what "forward port 5432" means.

Each accepted connection gets its own `direct-tcpip` channel: closing one (a
dropped HTTP request) must not disturb the others.

## The password is a device gate, not an account

It protects the stored host credentials if the phone is picked up unlocked. It is
stored as a salted SHA-256 and compared in constant time.

PBKDF2 would be stronger, but the threat model is a local sandbox: an attacker who
can read `auth.hash` can also read `master.key` and every secret file. Iteration
count would only slow down someone who has already won.

Changing the password requires the current one — otherwise whoever picks up an
unlocked phone could lock the owner out.

## Themes are derived, never duplicated

The 36 app themes live in `web/css/variables.css` and `utils/themeMeta.ts`. The
xterm palette is computed from the app theme's CSS custom properties at runtime
rather than being a second 36-entry table, which would drift the first time
someone adds a theme.

The 157 community palettes are inlined as data instead of imported from
`xterm-theme`: the package exports every scheme from one module, so importing it
to render a picker would put all 157 in the main bundle for a screen most users
never open.

## The build uses relative asset paths

The page is loaded from `file:///android_asset/web/`, so an absolute `/assets/...`
URL resolves to the filesystem root and every chunk 404s. `base: './'` plus
relative `href`s in `index.html` is what makes it work — and there is no server to
404 loudly, so the failure mode is a blank page.
