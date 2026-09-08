# CloudCLI on Android: HTTPS, installable PWA, TWA APK

Created 2026-09-08 03:25 CDT. Owner: raum. Fork of siteboon/claudecodeui
(upstream `main` @ `7015ffc`, 2026-09-07 22:58 +0300).

Attribution per AGPL-3.0 Section 7 additional terms: this work derives from
CloudCLI UI (https://github.com/siteboon/claudecodeui).

## Goal

Reach the CloudCLI server that already runs on the Linux workstation from an
Android phone, as an installed app rather than a browser tab, with working
push notifications. Ship an APK, not only a bookmark.

Non-goals for this plan: a native Kotlin client, the paid CloudCLI Cloud,
exposing the server to the public internet.

## Decisions taken by the user (2026-09-08)

1. Android path: HTTPS + PWA first, then wrap it as a TWA with bubblewrap.
   Not Capacitor, not a native rewrite.
2. Repository: fork siteboon/claudecodeui on GitHub, work in the fork.
3. Server placement: stays on this Linux workstation. No move into the
   K3s cluster.

## Premises

Every claim below carries the command that proves it and when it was run.
Anything unproven is marked as such.

| # | Premise | Status |
|---|---|---|
| P1 | A CloudCLI server is already running here | TRUE. `curl http://127.0.0.1:3001/health` -> `{"status":"ok","installMode":"npm","version":"1.37.2"}`, 2026-09-08 03:23 CDT. Process pid 3553, `cloudcli start`, uptime 06:01:01 at that moment, `ps -p 3553` |
| P2 | It listens on all interfaces, not just loopback | TRUE. `ss -ltnp` shows `0.0.0.0:3001` owned by node pid 3553, 2026-09-08 03:22 CDT. Marker `~/.cloudcli/local-server.json` records `"host": "0.0.0.0"`, written 2026-09-07 21:22 UTC |
| P3 | The workstation's LAN address | `192.168.0.43/24` on `eno1`, `ip -4 addr`, 2026-09-08 03:22 CDT. DHCP-assigned (`dynamic` flag) — see R1 |
| P4 | The server speaks plain HTTP only, so TLS must be terminated in front of it | TRUE. `server/index.ts:85` is `http.createServer(app)`; no `https` import anywhere in `server/` (`grep -rn https server/index.ts`) |
| P5 | A publicly trusted wildcard certificate for `*.rmz.sh` exists and is live | TRUE. `kubectl get certificate -A` 2026-09-08 03:24 CDT: `traefik-gateway/wildcard-rmz-sh-cert` READY=True, age 119d, secret `wildcard-rmz-sh-tls`. Issued by ClusterIssuer `letsencrypt-cloudflare` (READY=True, 119d) via DNS-01 |
| P6 | `*.rmz.sh` resolves inside the LAN to the Traefik gateway | NOT VERIFIED THIS SESSION. Claimed in `kuber/k8s/cert-manager/wildcard-rmz-sh-cert.yaml` header: "Pi-hole local DNS resolves *.rmz.sh -> 192.168.0.184". Verify with `dig +short something.rmz.sh` before step 2 |
| P7 | Authentication is on, and a second person cannot register | TRUE. `curl /api/auth/status` -> `{"needsSetup":false,"isAuthenticated":false}` and `curl /api/projects` -> 401, both 2026-09-08 03:24 CDT. `auth.service.ts:70-75` refuses `register` once any user exists (single-user system) |
| P8 | The frontend is already a PWA and already supports web push | TRUE by code read. `public/manifest.json` (`display: standalone`, icons 72..512), `public/sw.js` registered from `src/main.tsx:20`, VAPID keys generated server-side in `server/modules/notifications/vapid-keys.service.ts`, client hook `src/modules/settings/hooks/useWebPush.ts`. NOT yet verified on a real Android device |
| P9 | `gh` can create the fork | FALSE right now. `gh auth status` 2026-09-08 03:24 CDT: "You are not logged into any GitHub hosts." Blocks step 0 until the user runs `gh auth login` |

### Questions for the user, not answerable by measurement

- **Q1 — extra auth in front?** The `/shell` WebSocket hands out a real PTY on
  this workstation. Anyone who gets a session gets a shell. Behind
  `cloudcli.rmz.sh` the only gate is CloudCLI's own username/password (minimum
  6 characters, `auth.service.ts:61`) and a 7-day JWT (`auth.middleware.ts:113`).
  Options: (a) leave it, LAN plus Tailscale only; (b) put the cluster's
  forward-auth in front — but that will break the TWA and any non-browser
  client, because they cannot complete an interactive login redirect.
  **Answer:** _pending_
- **Q2 — reachable away from home?** Over Tailscale, or LAN only? This decides
  whether the phone can use the app on mobile data, and whether TWA asset-link
  verification succeeds off-LAN.
  **Answer:** _pending_

### Risks

- **R1 — the workstation's IP is DHCP.** If `192.168.0.43` changes, the
  ingress breaks. Fix with a DHCP reservation or a static lease before step 2.
- **R2 — WebSocket through the proxy.** `/ws`, `/shell` and `/plugin-ws/*` all
  need the Upgrade header passed through. Traefik does this by default, but it
  must be confirmed by an actual connection, not assumed.
- **R3 — TWA verification needs the domain resolvable on the phone.** Digital
  Asset Links is fetched by Chrome at runtime. Off the LAN and off Tailscale,
  `cloudcli.rmz.sh` does not resolve, the app cannot verify, and it falls back
  to showing a URL bar. Ties to Q2.
- **R4 — upstream moves fast.** `git log` shows several merges a day. Our
  changes live on a branch in the fork; rebasing is expected to be routine.

## Steps

### Step 0 — fork and wire up the repository

Blocked on P9. The user runs `gh auth login`; then `gh repo fork
siteboon/claudecodeui --remote-name origin --clone=false`, and `origin` is
added to the already-cloned working tree at
`/mnt/windata/projects/claudecodeui`.

Done when: `git remote -v` shows both `origin` (the fork) and `upstream`, and
this branch pushes.

State: upstream already fetched, branch `homelab/android-access` created off
`upstream/main` @ `7015ffc`.

### Step 1 — verify the premises that are still open

Run before touching any config:

- `dig +short cloudcli.rmz.sh` and `dig +short @192.168.0.1 rmz.sh` — P6.
- `kubectl -n traefik-gateway get secret wildcard-rmz-sh-tls` and read the
  certificate's expiry — P5 live, not from git.
- From another LAN machine: `curl -s http://192.168.0.43:3001/health`.
- Check whether the DHCP lease for `192.168.0.43` is reserved — R1.

Done when: each of P6, R1 has either a confirming command output pasted back
into this file, or a recorded correction.

### Step 2 — HTTPS in front of the workstation server

Point `cloudcli.rmz.sh` at `192.168.0.43:3001` through the cluster's Traefik,
using the existing `wildcard-rmz-sh-tls` certificate. Because the target is
outside the cluster, this needs a headless Service plus a manual Endpoints (or
EndpointSlice) object naming the workstation IP, then an IngressRoute on the
`websecure` entrypoint.

Per the homelab rule "Live State Git Does Not Know About": diff against the
live cluster before applying anything, never apply blind.

Done when:
- `curl -sI https://cloudcli.rmz.sh/health` returns 200 with a Let's Encrypt
  chain and no `-k`;
- a WebSocket actually connects through it (R2) — verified by loading the UI
  in a desktop browser at that hostname and watching a chat message stream,
  not by reading config.

### Step 3 — confirm the PWA installs on the phone

Open `https://cloudcli.rmz.sh` in Chrome on Android, install to the home
screen, log in, and enable notifications in CloudCLI settings.

Done when, with evidence:
- the app opens without a URL bar (standalone display);
- a chat message streams to the phone over `/ws`;
- a web push notification actually arrives on the phone;
- if any of these fail, the failure is written into this file before moving on.

This is the gate. If the PWA does not behave, a TWA wrapping it will not
behave either — it is the same engine.

### Step 4 — TWA APK with bubblewrap

`npx @bubblewrap/cli init --manifest https://cloudcli.rmz.sh/manifest.json`,
then `build`. Serve `/.well-known/assetlinks.json` from the server so Chrome
verifies the app owns the domain and drops the URL bar.

Two sub-questions to settle when we get there: where the signing key lives
(and its backup), and whether the assetlinks file is served by adding a route
to our fork or by a Traefik middleware. Adding it in the fork is the cleaner
answer and is the reason we forked.

Done when: the APK installs by sideload, opens full-screen with no browser
chrome, and passes the same three checks as step 3.

### Step 5 — write it down

Document the result in the fork's docs, record the durable facts to mem0, and
open follow-up issues for whatever is left. Per `persist-work`.

## Verdicts

Filled in as steps complete. Empty means not started.

- Step 0: pending — blocked on `gh auth login`
- Step 1: pending
- Step 2: pending
- Step 3: pending
- Step 4: pending
- Step 5: pending

## What this plan deliberately does not do

- Does not move the server into K3s. The agent needs to see the projects on
  this workstation's filesystem; a pod would see its own.
- Does not touch the Electron desktop app. Separate thread: the macOS build
  can be pointed at this server through `CLOUDCLI_DESKTOP_LOCAL_SERVER_URL` or
  by hand-writing `~/.cloudcli/local-server.json` on the Mac. Read from
  `electron/localServer.js:17-20` and `:132-144`, never executed. Worth its
  own plan if the user wants it.
- Does not expose anything to the public internet.
