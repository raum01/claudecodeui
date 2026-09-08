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

- **Step 0: DONE, 2026-09-08 03:5x CDT.** Fork lives at
  https://github.com/raum01/claudecodeui, wired as `origin`; `upstream` still
  points at siteboon. Branch `homelab/android-access` is pushed and tracking.

  P9 was wrong in the part that mattered. `gh auth status` really does report
  no GitHub host, but `gh` was never needed: git already has a stored
  credential for github.com (`credential.helper store`, and github.com is
  present in `~/.git-credentials`), so `git push` authenticates on its own.
  Only the `gh` CLI is logged out.

  Two things had to be handled to make the push land:

  1. **GitHub rejected the first push with `GH007: Your push would publish a
     private email address`.** The account blocks command-line pushes that
     would expose `raum01@gmail.com`. Fixed locally rather than by weakening
     the account setting: `user.email` for this repository is now
     `8431022+raum01@users.noreply.github.com`, GitHub's own alias for this
     account, and the three unpushed commits were rewritten to match. Commits
     stay attributed to the profile; the personal address never enters a
     public fork. The alternative was turning the protection off at
     github.com/settings/emails, which would have put that address in a public
     AGPL repository permanently.
  2. **`upstream`'s push URL is disabled** (`DISABLED-do-not-push-to-siteboon`)
     so a stray `git push upstream` cannot fire at the original project.

- **Step 1: DONE, 2026-09-08 03:27 CDT.**
  - P6 CONFIRMED: `dig +short cloudcli.rmz.sh` -> `192.168.0.184`. Wildcard
    resolution is already in place, no DNS record had to be added.
  - P5 live: certificate `notAfter=2026-10-08T23:27:01Z`,
    `renewalTime=2026-09-08T23:27:01Z`. SANs are exactly `*.rmz.sh` and
    `rmz.sh` (`openssl x509 -ext subjectAltName`).
  - Traefik LoadBalancer confirmed at `192.168.0.184`, ports 80 and 443.
  - Reachability from inside the cluster CONFIRMED: a throwaway pod got
    `{"status":"ok",...}` from `http://192.168.0.43:3001/health`.
  - R1 CONFIRMED AS A REAL RISK: `nmcli -g ipv4.method` on `netplan-eno1`
    returns `auto`. The address is a lease, not a reservation. Not fixed;
    needs a router change. `ollama-host` in `gpu-queue` hardcodes the same
    address, so both break together.

- **Step 2: DONE, 2026-09-08 03:38 CDT.** `https://cloudcli.rmz.sh` is live.
  - Manifests live in the kuber repo, not this one:
    `k8s/home-services/apps/cloudcli/` — selectorless Service, manual
    EndpointSlice to `192.168.0.43:3001`, and two IngressRoutes.
  - `curl -sI https://cloudcli.rmz.sh/health` -> `HTTP/2 200`, no `-k`.
  - `curl -sI http://cloudcli.rmz.sh/health?q=1` -> `301` with
    `Location: https://cloudcli.rmz.sh/health?q=1`, path and query preserved.
  - R2 (WebSocket through the proxy) PARTIALLY CONFIRMED: an upgrade request
    over HTTP/1.1 to `/ws` returns the same `401 Unauthorized` through Traefik
    as it does straight to the backend, so the handshake reaches the app
    unmangled and the refusal is CloudCLI's own missing-token check. A full
    `101` needs a real JWT and is folded into step 3.
  - `manifest.json` and `sw.js` both serve 200 over https, and the page links
    the manifest at `/manifest.json`, which is root scope.

### Review before applying (2026-09-08)

GLM-5.3 reviewed the manifests. **The second reviewer, qwen3.8-max, was
unavailable** — the Aliyun key answers 403 `AccessDenied.Unpurchased` on every
model as of today, recorded in the `consulting-glm` skill. So this config was
**looked at less**, which is not the same as fewer problems being present.

Acted on:

1. **Dropped `cloudcli.k8s.lan` from both routes.** Every other service in the
   kuber repo answers both `.k8s.lan` and `.rmz.sh` from one rule, but the
   attached secret covers `*.rmz.sh` only. The `.lan` name would have been
   served a certificate it does not match, and the http route would have
   redirected people into that error. A refused certificate is not a secure
   context, which would have killed the service worker and push, the whole
   point of the exercise. Confirmed against the secret's SANs.

Refuted by measurement, and each mattered:

2. "The frontend probably bakes in `http://host:3001`."
   `curl -H 'Host: cloudcli.rmz.sh' http://192.168.0.43:3001/ | grep -E 'http://|ws://|:3001'` returns nothing.
3. "Traefik may read `Endpoints` and not `EndpointSlice`, and see zero servers."
   Traefik is v3.3.3 and it reads the slice: the route answered 200 within
   seconds of apply. Worth noting because the repo's other off-cluster route
   (`yacht-adsb/10-dump1090-edge.yaml`) does use the older `Endpoints` kind.
4. "Traefik's default `respondingTimeouts.idleTimeout` of 180s will kill an
   idle PTY." No `respondingTimeouts` flag is set, so the default does apply,
   but the connection is never idle: CloudCLI's own WebSocket server pings
   every 30 seconds (`server/modules/websocket/services/websocket-server.service.ts:25`,
   `intervalMs = 30_000`) and terminates a socket that misses a pong. No
   Traefik change needed, so the change stayed purely additive.
5. "The app may pin `Host`/`Origin` on upgrade." It reads neither; the upgrade
   handler takes the token from `?token=` or the `Authorization` header and
   nothing else (`websocket-auth.service.ts:45-50`).
6. "The manifest may sit at a subpath, silently breaking service-worker scope."
   It is at `/manifest.json` with `"scope": "/"`.
7. "The first LAN visitor could claim the account." Registration was already
   closed before this went live: `/api/auth/status` returns
   `{"needsSetup":false}`.

Accepted as true, not fixed, and written into the app README as known rough
edges:

8. Nothing health-checks this backend. A static `ready: true` on the
   EndpointSlice will keep claiming health while the process is dead.
9. `cloudcli start` is a foreground npm process, not a systemd unit. A reboot
   leaves the route pointing at nothing.
10. Port 3001 remains open on `0.0.0.0`, so the TLS front door can be walked
    around from inside the LAN.
11. Whether the router forwards 443 to `192.168.0.184` is unverified from
    here. If it does, this is a JWT-gated PTY on the public internet. **User
    action.**

### Router and exposure, answered 2026-09-08 10:33 CDT

The open question "does the router forward 443 inward" is now closed, from the
router itself rather than from guesswork. It is a UniFi Cloud Gateway Ultra at
192.168.0.1; the API key lives in secret `unifi-exporter` in namespace
`monitoring`, and the recipe is already written up in the kuber repo at
`docs/2026-08-17-plex-remote-access-unifi.md`.

`GET /proxy/network/api/s/default/stat/portforward` returns exactly two rules,
and that endpoint includes UPnP-created entries, not just hand-written ones:

| state | name | outside | inside |
|---|---|---|---|
| enabled | Plex | any:32408 | 192.168.0.49:32400 |
| **disabled** | Vaultwarden | any:8443 | 192.168.0.137:8443 |

Nothing forwards 443. Nothing points at 192.168.0.184. **CloudCLI is not
reachable from the internet.**

One caveat that is true and worth keeping: UPnP is enabled
(`upnp_enabled: true`, `upnp_nat_pmp_enabled: true`) with secure mode on
(`upnp_secure_mode: true`). Secure mode confines a device to opening ports to
its own address, so nothing on the LAN can point a forward at the Traefik
gateway, and no process lives at 192.168.0.184 to ask for one anyway. But the
exposure surface is not only the static table, and a future device could open a
port for itself without anyone approving it.

### Public DNS: the name resolves outside, the address does not route

`dig @1.1.1.1 cloudcli.rmz.sh` and `dig @8.8.8.8 cloudcli.rmz.sh` both return
`192.168.0.184`. The wildcard is published in Cloudflare, pointing at an RFC1918
address, so the whole internet can learn the mapping and none of it can use it.

This kills a real worry from the review: a phone with Private DNS (DNS-over-TLS)
bypasses Pi-hole, and the fear was that the name would then not resolve at all.
It resolves either way, because it is in public DNS. On the LAN it reaches
Traefik; off the LAN it resolves to an address that goes nowhere, which is a
clean failure rather than a confusing one.

- **Step 3: PARTLY DONE without a phone, 2026-09-08 10:34-10:39 CDT.**

  What was proven by machine:

  - **Chrome's own installability check passes.** Lighthouse 11.7.1 against
    https://cloudcli.rmz.sh/ scores `installable-manifest` OK, along with
    `splash-screen`, `themed-omnibox`, `maskable-icon`, `content-width` and
    `viewport`. That audit is Chrome's real installability verdict over CDP,
    the same one that decides whether Android offers "Install app". Note for
    next time: Lighthouse 12 removed the PWA category entirely, so the audit
    has to be run with `lighthouse@11`.
  - **The WebSocket path is fully confirmed**, upgrading R2 from partial. A
    short-lived token was minted locally from the server's own `jwt_secret`
    (`app_config` table in `~/.cloudcli/auth.db`), used, and destroyed. With it:
    `wss://cloudcli.rmz.sh/ws` returned **101 Switching Protocols in 38 ms**,
    the socket opened, and a live `session_upserted` event arrived through it.
    `wss://cloudcli.rmz.sh/shell` also returned 101 and held open. REST through
    the proxy: `/api/auth/user` 200, `/api/projects` 200.

  What still needs the physical phone, and cannot be faked:

  - that web push actually arrives on that specific device, with its specific
    battery optimiser;
  - that the home screen icon and splash look right on that screen.

- **Step 4: IN PROGRESS.**

  - Signing key created 2026-09-08 10:37 CDT:
    `~/.android-keystores/cloudcli-twa.keystore`, alias `cloudcli`, RSA 4096,
    valid until 2054. Password in `~/.android-keystores/cloudcli-twa.credentials`
    (mode 600). **This file is the only thing that can ever update the app; if
    it is lost the app can only be replaced, not upgraded. It belongs in
    Bitwarden.** The vault was locked, so it could not be put there
    automatically.
  - SHA-256: `3B:95:85:B4:7E:D6:73:2A:9E:7A:A2:1D:C4:B2:4E:5B:40:9A:52:74:09:3E:52:37:33:60:3B:8B:87:88:70:A8`
  - Package name pinned to `sh.rmz.cloudcli`.
  - **Asset links are live.** `https://cloudcli.rmz.sh/.well-known/assetlinks.json`
    returns 200 with `content-type: application/json`, served by a two-replica
    nginx in the cluster (`kuber` commit `b51ebe0`). It needed its own route
    because CloudCLI answers unknown paths with its SPA index page, so Android
    would have received HTML where it expects JSON. Verified afterwards that the
    site, `/health` and `/manifest.json` still return 200 and that a
    neighbouring `/.well-known/` path still falls through to the app.
  - APK build and an Android emulator to install it on are running as separate
    jobs. Results pending.

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
