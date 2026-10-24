# ClawTerm

An SSH / SFTP terminal manager for Android — **a pure client**. The SSH client,
the database and the credential store all live inside the app process. Nothing
listens on a port, nothing runs in the background, and there is no companion
service to install.

![Hosts](docs/screenshots/hosts.png)

## Why there is no server

An earlier version of this project shipped a Go server inside the APK and had the
WebView talk to `127.0.0.1`. That is still a client-server design: a process
opening a socket, a protocol to keep compatible, a lifecycle to manage, and a
port that other apps on the device could reach.

This version removes all of it:

| | Before | Now |
|---|---|---|
| SSH | Go process over a local socket | JSch, in the app process |
| UI | served by the Go process | served from `assets/web/` over the asset-loader origin |
| Data | Go + SQLite over HTTP | SQLite directly, in-process |
| Credentials | Go + AES-GCM | Java `AES/GCM/NoPadding` |
| Open ports | 1 (loopback HTTP + WebSocket) | **0** |
| Processes | 2 | 1 |

The UI is still Vue in a WebView — that is a rendering choice, not a server. It
talks to the Java layer through one JavaScript bridge method.

It is served from `https://appassets.androidplatform.net/web/` via
`WebViewAssetLoader`, **not** from `file:///android_asset/`. A `file://` page has
an opaque origin and the browser blocks ES module and stylesheet loads from it
with a CORS error, which renders a completely blank screen. The reserved
`appassets.androidplatform.net` host is the official workaround and never leaves
the device.

## What it does

| | |
|---|---|
| **Multi-tab terminal** | One PTY-backed SSH channel per tab. Switching tabs keeps scrollback, the cursor position in a TUI, and the running process. |
| **Reconnect to the same shell** | A dropped WebView or a sleeping phone re-attaches to the same channel and replays the scrollback. |
| **Key bar** | Esc / Tab / Ctrl / Alt / arrows / `\|` `-` `/` `~` above the keyboard. Tap a modifier for one keystroke, long-press to lock it. |
| **Three interaction modes** | Browse (drag scrolls), Gestures (swipe = arrows with hold-to-repeat, two-finger swipe = PgUp/PgDn, double-tap = Tab, pinch = font size), Select (drag paints a cell range with a copy/paste bar). |
| **In-terminal search** | Match count, next/previous, highlight colours derived from the active palette. |
| **157 terminal palettes** | Every scheme from `xterm-theme`, plus "follow the app theme". |
| **SFTP file browser** | Browse, preview text, save to the device through the system picker. |
| **Command snippets** | Saved commands, global or scoped to one host. |
| **36 themes** | The same VS Code-style palette set, applied to the UI *and* the terminal. |
| **Host key verification** | Trust-on-first-use pinning, with both fingerprints shown when a key changes. |

## Build

```bash
./build.sh              # debug APK
./build.sh --release    # signed release APK
```

Output: `android/app/build/outputs/apk/{debug,release}/clawterm-android*.apk`

There is no other artifact. `build.sh` also asserts the APK contains **no native
libraries** — one was how the previous version shipped a Go server, so a revert is
caught at build time.

### Development

```bash
npm run dev        # Vite on :5173 — but the app needs the native bridge,
                   # so a browser shows "this build needs the app shell"
npm test           # 111 frontend tests
npx vue-tsc --noEmit -p web/tsconfig.json

cd android && ./gradlew testDebugUnitTest   # 30 native tests
```

The frontend can be driven in a browser by installing a fake
`window.ClawTermNative` (see `web/src/native/__tests__/bridge.test.ts` for the
protocol). That is how the UI is tested without an emulator.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│ WebView (https://appassets…/web/index.html)          │
│   Vue 3 · xterm.js · 111 tests                       │
│                                                      │
│   window.ClawTermNative.invoke(id, method, json) ───┐│
└─────────────────────────────────────────────────────┼┘
                                                      │
┌─────────────────────────────────────────────────────▼┐
│ App process (Java)                                   │
│   BridgeDispatcher   one switch over 26 methods      │
│   SshConnection      JSch session + PTY channel      │
│   TerminalManager    sessions + scrollback ring      │
│   Db                 SQLite (hosts, snippets, pins)  │
│   SecretStore        AES-GCM files + password hash   │
└──────────────────────────────────────────────────────┘
```

### The bridge

One `@JavascriptInterface` method, not twenty-six:

```java
public void invoke(String requestId, String method, String payloadJson)
```

Each `@JavascriptInterface` is a magic string that must match on both sides and
be kept by R8; a typo only shows up at runtime as "method not found". With one
entry point, the method names live in one TypeScript union and one Java `switch`.

Requests are correlated by id (two concurrent calls must not settle each other's
promises), replies are `ok`/`error` with a **stable code** the UI translates, and
every request has a timeout so a native crash mid-call cannot hang the UI.

Terminal output crosses as **base64**, not text: a PTY stream is arbitrary bytes,
and a multi-byte character split across two reads is normal. The view decodes with
`TextDecoder(stream: true)` so a split character is held, not turned into two
replacement characters.

### Where data lives

```
/data/data/com.clawterm.app/files/clawterm/
  clawterm.db          hosts, snippets, pinned host keys
  secrets/master.key   AES-256 key (0600)
  secrets/<id>.password
  secrets/<id>.passphrase
  secrets/auth.hash    salted SHA-256 of the access password
```

The database and the credential store are deliberately separate files: a
database copied for backup is not a copied credential store, and deleting a host
removes its secret with a single unlink.

**What the encryption does and does not do.** The key sits next to the data, so
this is not a defence against someone who can read the app's private directory —
on Android that boundary is the OS sandbox. It buys two real things: a shared
backup leaks no readable credentials, and the files are not greppable. Saying so
plainly matters: a user who thinks these files are safe to hand around is worse
off than one who knows they are not.

## Security notes

- **No listening socket.** Verified at build time (no native libs) and by design:
  the app never binds a port, so nothing on the device or the network can reach
  it. `ServerSocket` does not appear anywhere in the source.
- The UI origin is `appassets.androidplatform.net`, a reserved domain that cannot
  resolve on the internet; the asset loader intercepts it inside the WebView.
- The access password is a **local device gate**, not an account. It is stored as
  a salted SHA-256 and compared with `MessageDigest.isEqual` (constant time).
- Changing the password requires the **current** one, so an unlocked phone cannot
  be locked out by whoever picks it up.
- A fresh install starts **locked**: the setup screen is the only way in.
- Host keys are pinned on first connect. A changed key fails the handshake and
  reports both fingerprints; re-pinning is an explicit action.
- No storage permission is requested; everything is in the app sandbox.
- `allowBackup="false"`, so the credential files are not swept into a cloud
  backup.

## Project layout

```
android/app/src/main/java/com/clawterm/app/
  MainActivity.java      WebView + wiring; no server
  BridgeDispatcher.java  the request switch
  SshConnection.java     JSch session, PTY, SFTP, host-key pinning
  TerminalManager.java   sessions + ring buffer
  Db.java                SQLite
  SecretStore.java       AES-GCM + password hash
  AppConfig.java         paths, theme, lock state
web/src/
  native/                bridge client + typed API (protocol.ts is the contract)
  composables/           state: hosts, tabs, sessions, gestures, settings
  components/            panels, sheets, shared primitives
  utils/                 themes, key sequences, palette data
```

## Licence

MIT.
