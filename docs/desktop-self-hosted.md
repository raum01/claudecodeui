# Desktop app for a self-hosted CloudCLI server

The upstream desktop app (`electron/`) opens two kinds of CloudCLI: a Local server
on the same computer, and CloudCLI Cloud environments. This fork adds a third: a
**self-hosted server on another machine**, such as a home workstation reached at
`https://cloudcli.example.com` (upstream issue siteboon/claudecodeui#940).

When a server is configured, the app opens it in its own tab on start. The app only
connects: it never installs or starts a server for it. If the server does not
answer `/health`, the tab says so, and Refresh (or Environment > Open <host>) tries
again. The configured origin is trusted like `localhost` and `*.cloudcli.ai`
already are: the page may ask for notification, clipboard-read and media
permission, and it gets the desktop notification bridge, so CloudCLI's own
settings offer native notifications instead of browser web push (which Electron
does not have).

## Configuring the server

First match wins:

1. `CLOUDCLI_DESKTOP_SERVER_URL` in the environment. Handy for development; a
   macOS app started from Finder does not see shell variables.
2. `self-hosted-server.json` in the app's data directory, expected at
   `~/Library/Application Support/CloudCLI/` on macOS (the exact path is the
   `userDataPath` field of CloudCLI > Diagnostics > Copy Diagnostics). Use this to
   repoint an installed app: editing files inside the app bundle would break its
   signature. The launcher's "Self-hosted server" card shows which source is in use.
3. `electron/self-hosted-server.json` inside the app, written at build time from
   `CLOUDCLI_DESKTOP_BUNDLED_SERVER_URL`.

Both files contain `{"url": "https://cloudcli.example.com"}`: scheme, host and
optional port, no path (CloudCLI serves from the root of its origin). A value that
is present but malformed, or has a path, is reported as an error at start-up; the
app does not fall back to another server.

Use `https`. A plain `http://` server is accepted, for example an address that is
only reachable over an encrypted VPN, but then anyone on the network path between
the Mac and the server can impersonate it: they would receive the password typed
into the login form, and with it a shell on the server. The trust the app extends
to the configured origin (permissions, the notification bridge) goes with it.

## Building the macOS app on Linux

```sh
npm ci
CLOUDCLI_DESKTOP_BUNDLED_SERVER_URL=https://cloudcli.example.com \
CLOUDCLI_DESKTOP_APP_ID=com.example.cloudcli.desktop \
RCODESIGN=/path/to/rcodesign \
  scripts/release/build-desktop-mac-selfhosted.sh arm64 x64
```

Output: `release/desktop/cloudcli-desktop-<version>-mac-<arch>.zip` and
`SHASUMS256-mac-selfhosted.txt` (`release/` is git-ignored).

- `arm64` is for Apple Silicon Macs (M1 and later), `x64` for Intel Macs.
- `rcodesign` is apple-codesign from
  https://github.com/indygreg/apple-platform-rs/releases. The build ad-hoc signs
  the app with it (`scripts/release/adhoc-sign-mac.cjs`). Apple Silicon refuses to
  run code with a missing or broken signature, and electron-builder cannot sign
  anywhere but on a Mac.
- The script zips the app itself with Info-ZIP `-y`. electron-builder's own mac zip
  target, run on Linux, stores the symlinks inside `Electron Framework.framework`
  as copies; the script fails if the counts differ.

What cannot be done off a Mac: Developer ID signing and notarization (they need an
Apple Developer account and Apple's tools; upstream's CI does them for its
releases), and a `.dmg` (electron-builder creates DMGs only on macOS).

## Installing on the Mac

1. Copy the zip to the Mac and double-click it; move `CloudCLI.app` to
   Applications.
2. The first launch is refused, because the app is ad-hoc signed, not notarized.
   Open System Settings > Privacy & Security, find the message about CloudCLI and
   choose "Open Anyway". Or, once, in Terminal:
   `xattr -dr com.apple.quarantine /Applications/CloudCLI.app`.
3. Log in to CloudCLI in the app. Under Settings > Notifications turn on desktop
   notifications; macOS then asks whether CloudCLI may show notifications.

Away from the network the server lives on, the Mac needs whatever reaches it (for
the homelab this is written for: Tailscale with "Use Tailscale subnets" on).

## Checking a build without a Mac

Verified on Linux for the 2026-09-29 build: architecture of the main executable,
ad-hoc signature present with the right identifier on the app, its helpers and
Electron Framework (`rcodesign print-signature-info`), 14 framework symlinks stored
as links, no world-writable files, bundled URL present. The same JavaScript was run
as a Linux Electron app against the live server.

Not verifiable here: that macOS accepts the signature
(`codesign --verify --deep --strict --verbose=2 /Applications/CloudCLI.app`), that
Gatekeeper's "Open Anyway" path works, and that notifications appear in macOS
Notification Center. Run that `codesign` command on the Mac first if the app does
not start.
