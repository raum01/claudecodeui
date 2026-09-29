# One live process per conversation, and native clients

Owner request 2026-09-29 ~13:45 CDT: fix CloudCLI so everything works, push to our GitLab,
track CloudCLI work in one project, and have an agent build Android and Mac apps with
remote access to the CloudCLI server, reusing what exists.

GitLab: `root/claudecodeui` (project id 17, private), remote `gitlab`, created 13:50 CDT;
`main` and `homelab/android-access` pushed. `origin` stays the public GitHub fork.

## Part A: one conversation, one process (branch `homelab/one-process`)

### What is broken (measured 2026-09-29, rom-sorter conversation e6ca8f38)

CloudCLI spawns a new `claude --resume=<id>` per user message. A process whose turn
launched background work (Bash/Agent/Task with `run_in_background`, Monitor, CronCreate,
...) is held alive (stdin kept open, `createHeldPromptStream`, ceiling
`CLOUDCLI_BG_WAIT_CEILING_MS`, default 30 min). Its background agents report back to
THAT process, which then takes further turns on its own. The next user message spawns
another process from the same transcript. Observed: PID 224353 (12:59:47) and 433404
(13:31:43) both driving the same plan for ~7 min; both resumed the same agent ids;
duplicate agents overwrote each other's files. The owner only sees the newest process.

`addSession` does interrupt a superseded instance and release its stdin when the new run
registers under the same app session id; it did not stop 224353. Find out why (different
key? interrupt only stops the current turn while notification-driven turns continue?).

### Target behaviour

A new user message for a conversation that still has a live, held CLI process is written
into that process's held input stream (it is an async iterable that is still open), not
given to a newly spawned process. Only when no live process exists is one spawned with
`--resume`. Background agents therefore always report to the process the owner is talking
to. Abort, supersede, reconnect and the ceiling keep working.

### Steps

- [ ] A1. Study first: upstream `main` (fetched 13:52, head dc7cb6c6) since our base 7015ffc,
      in particular #1291 (hold the CLI open for backgrounded agents), #1347 (recover
      background-agent results) and branch `fix/interrupt-a-busy-run-instead-of-failing-to-send-for-scheduled-messages`;
      upstream issues/PRs about duplicate processes. If upstream already solves it,
      adopt upstream instead of writing our own.
- [ ] A2. Reproduce in a test: a fake CLI (or the SDK with a stub) where turn 1 starts a
      background agent, and turn 2 arrives while the process is held. Today: two
      processes. Must fail before the fix.
- [ ] A3. Fix in source (make the held stream a queue; route a new turn into the live
      process; spawn only when none is live). Keep existing tests green, add new ones.
- [ ] A4. Run a second CloudCLI instance from the branch on a spare port with a scratch
      HOME/config, prove on it with a real `claude` session: one PID across two messages
      while a background agent runs; the agent's result reaches the owner-visible turn.
- [ ] A5. Deploy to the live service (`systemctl --user` unit `cloudcli`, currently the npm
      global install 1.37.3). Restarting it kills every running conversation, including
      the orchestrator's: the orchestrator schedules that restart, not the agent.
- [ ] A6. Upstream: prepare an issue/PR text for siteboon with the reproduction; the owner
      decides whether to send it.

## Part B: native clients with remote access (branch `homelab/apps`)

What exists already (read `docs/plans/2026-09-08-cloudcli-android-access.md` and
PROGRESS.md; do not redo it): `https://cloudcli.rmz.sh` live with a trusted certificate;
PWA installable; a TWA APK in `android-twa/`, installed on the owner's phone and running
without an address bar (commit 60a76f0). Upstream ships an Electron app (`electron/`,
including `cloud.js`, `localServer.js`, `serverInstaller.js`).

- [x] B1. Survey before building: what the upstream Electron app already does for a remote
      server (can it point at `cloudcli.rmz.sh`?), official CloudCLI mobile/desktop
      releases, and open-source Claude Code remote clients for Android and macOS.
      Decision table: reuse / adapt / build, with reasons.
      **Done 2026-09-29 14:05 CDT**, see "B1 survey" below.
- [x] B2. Remote access from outside the home: how `cloudcli.rmz.sh` is reachable today
      (LAN only? Tailscale? Cloudflare?), and the proper way to reach it away from home
      without exposing an unauthenticated shell to the internet. Measured, not assumed.
      **Done 2026-09-29 14:05 CDT**, see "B2 reachability" below. Nothing was changed.
- [x] B3. Android: bring the TWA to current state (or replace it if B1 finds better);
      signed APK; notifications if feasible.
      **Done 2026-09-29 14:10 CDT**, see "B3 Android" below. The app itself needed no
      change; its sources and a safe, reproducible build now live in git.
- [x] B4. macOS: an app that opens our server; build it from Linux if the toolchain allows
      (unsigned zip/dmg), otherwise document exactly what needs a Mac.
      **Built 2026-09-29 15:01 CDT**, see "B4 macOS" below. Ad-hoc signed zips for
      arm64 and x64; never run on a Mac.
- [x] B5. Verify each client against the live server; evidence in the plan.
      **Done as far as this host allows, 2026-09-29 14:04-15:00 CDT**, see "B5
      verification" below. The phone and a Mac are still needed for the last mile.

### B1 survey (2026-09-29, 13:50-14:05 CDT)

What was read or run, and what it showed:

- **Upstream desktop app, `electron/` at our base.** It knows two kinds of target: "Local
  CloudCLI" (a server on this machine, found or started) and CloudCLI Cloud environments
  (`cloud.js`, driven by a cloudcli.ai account API key). There is no "self-hosted server
  on another machine" target. The only way in is the local-server discovery in
  `localServer.js`, which accepts a URL from `CLOUDCLI_DESKTOP_LOCAL_SERVER_URL` or from
  `~/.cloudcli/local-server.json`.
- **That route is broken for an https server, measured.** `addCandidateUrl` accepts
  `https:` but the health probe uses `http.get`. Running the real module with
  `CLOUDCLI_DESKTOP_LOCAL_SERVER_URL=https://cloudcli.rmz.sh` fails with
  `ERR_INVALID_PROTOCOL Protocol "https:" not supported. Expected "http:"` (13:57 CDT).
  The 09-08 plan's note "the macOS build can be pointed at this server through
  `CLOUDCLI_DESKTOP_LOCAL_SERVER_URL`" is therefore wrong for our URL. Even with it fixed,
  an unreachable server would fall through to downloading a ~290 MB local-server bundle
  from GitHub and starting a server on the Mac, which is not what a client should do.
- **Upstream also trusts only `localhost` and `*.cloudcli.ai`** for web permissions
  (`desktopWindow.js` `isAllowedPermissionOrigin`) and for the native-notification bridge
  (`preload.cjs` `isCloudCliAppOrigin`), so notifications from our origin would be denied.
- **Upstream releases** (GitHub API, 13:58 CDT): each release through v1.37.2 ships
  `cloudcli-desktop-<v>-mac-arm64.dmg` and a Windows installer, signed and notarized in CI
  (`desktop-release.yml`, Developer ID secrets). v1.37.3 ships no desktop artefacts. No
  Linux desktop build, no x64 Mac build, no mobile app.
- **Upstream issue #940** (open since 2026-06-30): "CloudCli Desktop support to connect a
  self-hosted remote cloudcli-local-server". No PR implements it. That is exactly our case.
- **cloudcli.ai mobile**: its docs describe the PWA ("add to home screen") and say a native
  app is "in development". Nothing to install.
- **Third-party remote clients for Claude Code** (search 13:59 CDT): Happy Coder
  (slopus/happy-cli, native iOS/Android through its own relay), remoteCC, remotelab,
  247-claude-code-remote, Claude-Code-Remote (email/Telegram). Each replaces CloudCLI
  with its own server or relay. None is a client for a CloudCLI server.
- **Web push inside Electron does not exist** (no push service), but the frontend already
  handles this: when `window.cloudcliDesktopNotifications` is present it hides web push and
  drives the desktop app's native channel instead (`useWebPush.ts:28`, `Settings.tsx:43`).
  That channel (`/desktop-notifications` WS plus `/api/notifications/endpoints/*`) accepts
  the ordinary login JWT and exists in the live npm 1.37.3 build.

| Client | Option | Decision | Why |
|---|---|---|---|
| Android | Our TWA (`sh.rmz.cloudcli`, bubblewrap) | **Reuse** | Already signed, installed and verified without an address bar. It is the live PWA in Chrome, so it gets every server upgrade for free and has real web push. No alternative on the list talks to a CloudCLI server. |
| Android | Happy Coder, remoteCC, others | Reject | Each needs its own server or relay beside CloudCLI and gives a different UI. |
| Android | Native rewrite / Capacitor | Reject | Ruled out by the owner on 09-08; nothing found changes that. |
| macOS | Upstream DMG unmodified | Reject for now | Signed and notarized, but cannot open an https self-hosted server (measured above) and would deny our origin notifications. Becomes the right answer if upstream accepts #940. |
| macOS | **Upstream Electron, adapted** | **Adapt (chosen)** | Smallest change that gives a real app: a configured self-hosted server as a first-class target, https health probe, our origin trusted for permissions and native notifications. Everything else (tabs, tray, menus, Local, Cloud) stays upstream's. Written so it can go upstream as the fix for #940. |
| macOS | Safari "Add to Dock" / Chrome "Install app" | Keep as fallback | Zero build and already works (Lighthouse installable, 09-08). Documented for the owner as the no-install-risk route; the Electron build adds native notifications without a browser and a tray. |
| macOS | Own Electron/Tauri shell from scratch | Reject | Would duplicate what upstream already maintains. |

### B2 reachability (measured 2026-09-29 13:50-13:55 CDT, nothing changed)

- **LAN: works.** `https://cloudcli.rmz.sh/health` 200 through Traefik at 192.168.0.184,
  certificate valid (issuer Let's Encrypt YR1, `notAfter=Dec 21 04:14:58 2026 GMT`; it has
  renewed since 09-08). Server reports npm 1.37.3. `assetlinks.json` 200 `application/json`
  with package `sh.rmz.cloudcli` and the 3B:95:85:... fingerprint.
- **Public DNS publishes the private address.** `cloudcli.rmz.sh` resolves to
  `192.168.0.184` from the LAN resolver, 1.1.1.1 and 8.8.8.8. The apex `rmz.sh` has no
  public A record. NS is Cloudflare.
- **Nothing forwards inward.** Router (UniFi, `stat/portforward` read-only, 13:52 CDT)
  holds the same two rules as on 09-08: Plex `any:32408 -> 192.168.0.49:32400` enabled,
  Vaultwarden 8443 disabled. Nothing to 443, nothing to 192.168.0.184.
- **Cloudflare Tunnel exists but does not carry CloudCLI.** Live `cloudflared-config`
  routes only `plex.rmz.sh`, catch-all 404.
- **Tailscale is already a working path in principle.** The cluster's `tailscale-router`
  (`k8s-router`, 100.88.235.3, pod up 7d13h) advertises `192.168.0.0/24` and
  `10.43.0.0/16`, and both are in its `PrimaryRoutes`, i.e. approved. A tailnet device that
  accepts subnet routes can reach 192.168.0.184, and public DNS already gives it that
  address, so `https://cloudcli.rmz.sh` needs no change to work away from home.
  Tailnet state: the phone `s-s25-ultra` was last seen 2026-05-03 (149 days), the Mac
  `Dart` 2026-09-20, this workstation's own client is logged out (`NeedsLogin`, last seen
  2026-09-01). **Not measured end to end**: no tailnet peer outside the LAN was available
  to curl from without adding a node to the owner's tailnet.
- **SSO in the cluster** is Pocket-ID + oauth2-proxy (`auth/sso-gate` forwardAuth), not
  Authentik.

Options for away-from-home access, the owner decides:

1. **Tailscale (recommended).** No server, DNS or router change. Owner signs the phone and
   the Mac back into the tailnet and checks "Use Tailscale subnets" is on. Nothing is
   exposed to the internet; the gate is tailnet membership plus CloudCLI's own login.
   Optional hardening: a tailnet grant restricting 192.168.0.184:443 to the owner's
   devices. Cost: Tailscale must be on for the app to connect off-LAN. The TWA's full-screen
   check does not need Google's servers to reach the site (measured in B3), so nothing
   about it changes off-LAN.
2. Cloudflare Tunnel plus Cloudflare Access. The tunnel is already running for Plex. Works
   for the browser, the PWA and the TWA (Access cookie on the same origin), but the
   Electron main process opens the notification WebSocket itself and would need an Access
   service token. Puts a PTY-granting app on a public hostname behind two logins.
3. Port-forward 443 plus oauth2-proxy forwardAuth. Exposes the home IP, and the forwardAuth
   redirect cannot be completed by non-browser WebSocket clients. Not recommended.
4. Port-forward without extra auth. Rejected: a shell with the owner's permissions behind a
   single password on the internet.

### B3 Android (2026-09-29 14:00-14:10 CDT)

Nothing in the installed app needed changing: it points at `https://cloudcli.rmz.sh/`,
which is also the right address away from home (via Tailscale, B2), notification
delegation is already on (`enableNotifications: true`, `POST_NOTIFICATIONS`), and a TWA
takes every UI change from the server. So no new version was cut; the phone keeps
1.0.0 (versionCode 1).

What was wrong was around the app. Its sources existed only as an untracked directory in
the main checkout, because `.gitignore` excluded `android-twa/` wholesale. Now tracked
(commits 720d74d9, ed96bcb7): `twa-manifest.json`, both generator scripts, the pinned
bubblewrap lockfile, `emulator.sh`, a new `build.sh` and a README. The ignore rule is a
whitelist, so generated files, `dist/`, screenshots and anything new stay out.

`android-twa/build.sh` builds unsigned and signs with `apksigner --ks-pass env:...`,
because bubblewrap's own signing passes both passwords as `pass:<secret>` arguments
visible in `ps`. It refuses to finish unless the signer matches the fingerprint served
in the live `assetlinks.json`, and only then moves the APK into `dist/`.

- Positive run 14:01 CDT, 34 s: `dist/cloudcli-1.0.0.apk`, SHA-256
  `2c3699eed5f20769bd23e87666504dc79859a46fbe942388b68399594fa42044`, **byte-identical
  to the 09-08 APK installed on the phone**, so the tracked sources reproduce it.
- Negative run with a throwaway key: exit 1, "signer D71D... is not published", and the
  good APK in `dist/` was left untouched (after a fix: the first version of the script
  had already overwritten it, found by this test).

Signing key location unchanged: `~/.android-keystores/cloudcli-twa.keystore` plus
`cloudcli-twa.credentials` (mode 600). The keystore file itself is mode 664.

**Correction to the 09-08 record, measured.** Android's own App Links verification for
the app is not "verified": `pm get-app-links sh.rmz.cloudcli` reports
`cloudcli.rmz.sh: 1024` (a verifier-defined failure). That verifier goes through Google's
Digital Asset Links API, and Google cannot fetch a file from a private address:
`assetlinks:check` returns `ERROR_CODE_FETCH_ERROR` (13:55 CDT). It does not matter for
the TWA: Chrome decides full-screen itself, and the app still opened without an address
bar after `pm clear com.android.chrome` wiped Chrome's state (14:08 CDT, screenshot
`android-twa/evidence/b5-twa-after-chrome-clear.png`, git-ignored).

### B4 macOS (2026-09-29 14:10-15:01 CDT)

Upstream's Electron app, adapted (decision in B1). User-facing description and the
install steps: `docs/desktop-self-hosted.md`.

Code (`electron/`):
- `selfHostedServer.js` (new): resolves the server URL, first match wins:
  `CLOUDCLI_DESKTOP_SERVER_URL`, `<userData>/self-hosted-server.json`, then
  `electron/self-hosted-server.json` written into the app at build time. A malformed
  value, or one with a path, is an error, never a fallback to another server.
- `main.js`: a `server` tab kind that is opened on start; probe `/health`, show the page
  or a "not reachable, connect Tailscale, then Refresh" placeholder; one open at a time;
  drawing stops quietly if the user leaves the tab during the probe. The self-hosted
  server always registers for notifications under a persisted installation id.
- `localServer.js`: the health probe speaks https (upstream bug, ERR_INVALID_PROTOCOL)
  and has an overall deadline (a server trickling bytes held it open forever).
- `desktopWindow.js`, `viewHost.js`, `preload.cjs`: the configured origin is trusted for
  permissions and gets the notification bridge; permissions are now judged by the frame
  that asks, not the top page (upstream behaviour let any iframe inherit them).
- `desktopNotifications.js`: persisted installation id; a failed first-run write no
  longer aborts start-up. Launcher: a "Self-hosted server" section.
- Cherry-picked upstream 4cd470f (#1405, view sizing after maximize).
- Tests: `electron/selfHostedServer.test.js`, `npm run test:desktop`, 10/10 pass. The
  https test fails on the pre-fix code (ERR_INVALID_PROTOCOL) and the trickle test hangs
  on the pre-deadline code (timed out at 8 s); both checked by running.

Build (`scripts/release/build-desktop-mac-selfhosted.sh`, afterPack hook
`adhoc-sign-mac.cjs`): electron-builder `--mac dir` into `~/.cache/cloudcli-desktop-mac`
(ext4), ad-hoc signing with rcodesign 0.29.0 (installed at
`~/.local/share/apple-codesign/0.29.0/`, release checksum verified), then Info-ZIP `-y`.
Two defects of the obvious route were found by inspecting the output: electron-builder's
Linux mac zip stored **0 symlinks** (framework layout broken, 324 MB), and files from this
NTFS checkout were **mode 777**. Both are now checked by the script, together with the
architecture, the ADHOC flag on all 5 executables, and the executable bit in the zip.

Artefacts (git-ignored, `release/desktop/` in this worktree), bundle id
`sh.rmz.cloudcli.desktop`, bundled URL `https://cloudcli.rmz.sh`, app version 1.37.2:

```
9d881af9a13b1ff5ec01a19364afd680b4af2521778b1a5ca7393c27be2c4080  cloudcli-desktop-1.37.2-mac-arm64.zip  (117.7 MB, Apple Silicon)
39fd574dd759a3ccc30877c9f8f879f28efd5106c196dd28610dc54f1db79a79  cloudcli-desktop-1.37.2-mac-x64.zip    (124.4 MB, Intel)
```

Needs a Mac, by Apple's design: Developer ID signing and notarization (Apple Developer
account), a `.dmg`, and any proof that macOS accepts the signature
(`codesign --verify --deep --strict`), that Gatekeeper's "Open Anyway" works and that
notifications reach Notification Center. None of this was run.

Review: GLM-5.3, two rounds (14:38 and 14:57 CDT). qwen3.8-max unavailable (HTTP 403
`AccessDenied.Unpurchased` at 14:32 CDT), so one reviewer looked: less looking, not
fewer problems. Round 1 acted on: iframe permission inheritance (confirmed by
measurement first), three async races (one produced a raw error dialog when a tab was
closed 60 ms in, measured), device-id switching, first-run write crash, build-script
blind spots, URL paths. Round 2 acted on: unbounded probe (confirmed by a hanging test),
`grep -q` under pipefail, zero-executables pass. Discarded with reasons: env precedence
warning (documented, shown in the launcher), `/health`-shape identity (inherent, URL
shown), overwrite of a corrupt settings file, programmatic tab switches during a probe,
window-close throw (the code returns early), runtime config change (config is fixed at
start), wrong-id PATCH after cloud logout (connections are cleared first), presence-check
change (upstream's also always passed), non-Mach-O files under `Contents/MacOS` (dying
there is the safe direction).

### B5 verification (2026-09-29)

Android, emulator (Android 14, Chrome 113), live server:
- 14:07 CDT installed 1.0.0 relaunched: foreground `CustomTabActivity`, CloudCLI login
  page full screen, no address bar. Again at 14:08 after `pm clear com.android.chrome`.
- The rebuilt APK is byte-identical to the installed one, so this also covers it.
- Not verified here: login and chat on the phone, web push delivery on the phone (the
  owner's stored preference has `webPush: false`, read 14:18 CDT, so push is currently
  off on the server side), and anything off-LAN over Tailscale.

macOS client code, run as a Linux Electron app (Xvfb, `--no-sandbox` for the harness
only) against the live server:
- 14:16 CDT: opened `https://cloudcli.rmz.sh/` on start, service worker registered; in the
  remote page `cloudcliDesktopNotifications` present, `cloudcliDesktop` absent,
  notification permission granted.
- 14:17-14:18 and again 14:51 CDT with a 10-minute token minted from the server's own
  secret, never written to disk: native notification channel connected to
  `wss://cloudcli.rmz.sh/desktop-notifications` (`connectedCount: 1`), one endpoint
  registered under the persisted installation id, then deleted. Server state afterwards
  as before: no desktop endpoints, `channels.desktop: false` (the default; the row's
  `updated_at` moved to 19:51:26 UTC). Scratch profiles deleted.
- A `https://example.com` iframe in the server page was granted notifications before
  the permission fix (run started 14:43 CDT) and denied after it (run started 14:47).
- 14:48-14:50 CDT, unreachable server (`https://192.0.2.1`): placeholder with
  instructions; Refresh re-probes (8 s); closing the tab at 0 ms or 3 s and switching
  away at 3 s leave no dialog, no stray view and no focus steal (X display captures).
- 14:59 CDT final code: live server loads as before.
- The staged app (bundled config, no environment variable) found and loaded the server
  from `electron/self-hosted-server.json`.

## Rules

- Parts A and B work in separate git worktrees; neither restarts the live `cloudcli`
  service.
- Commits on this public fork use `8431022+raum01@users.noreply.github.com`; nothing
  secret enters the repo (signing keys stay out, see 3b9c708).
- Push to both `gitlab` and `origin`.
