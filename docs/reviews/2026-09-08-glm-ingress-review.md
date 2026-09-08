### prompt file: glm_cloudcli_ingress.txt
### endpoint OK: https://api.z.ai/api/coding/paas/v4/chat/completions

Verdict up front: the manifests are mechanically sound for the happy path (selectorless Service + manual EndpointSlice is the correct pattern for an off-cluster backend, and the http/https split obeys your recorded 404 lesson). The problems are unenforced invariants, one documented Traefik default that will kill idle PTYs, and one outright defect: `cloudcli.k8s.lan` on the TLS route with a cert that doesn't cover it.

## 1. Invariants relied on but not enforced

- **192.168.0.43 never changes.** The EndpointSlice hard-codes it, `ready: true` is a static assertion, and nothing reconciles it — a selectorless service gets no probes, ever. The host is on `ipv4.method = auto`. Breaks on any lease change; observed as Traefik 502s with `dial tcp 192.168.0.43:3001: connection refused` (or timeout) in `kubectl -n kube-system logs -l app.kubernetes.io/name=traefik`, while the EndpointSlice still reports the dead IP as ready. Cheapest enforcement: DHCP reservation on the router, plus ideally something that rewrites the slice when the lease does change.
- **The npm process stays up.** It's a bare process; reboot or crash produces the same 502s with the same lying `ready: true`. No systemd unit, no liveness anything.
- **The cert covers every host the route answers.** `wildcard-rmz-sh-tls` covers `*.rmz.sh`; the websecure route also answers `cloudcli.k8s.lan`, and Traefik will serve the rmz.sh cert for it regardless of SNI match. Worse, your http route *redirects* `.lan` traffic into that broken TLS handshake. Observed: `NET::ERR_CERT_COMMON_NAME_INVALID`; PWA install, SW, and push all impossible on that origin. See Q5.
- **Traefik consumes EndpointSlices.** You created no v1 `Endpoints` object. Current Traefik does; an older one watching only Endpoints sees zero servers. Observed within seconds of apply: non-200 on `curl https://cloudcli.rmz.sh/health` plus a "no servers"/endpoint error in Traefik logs. Verify the shipped Traefik version: `kubectl -n kube-system get pods -l app.kubernetes.io/name=traefik -o yaml | grep image:`.
- **The app tolerates being proxied**: accepts `Host: cloudcli.rmz.sh`, doesn't reject `Origin: https://cloudcli.rmz.sh` on upgrade, emits only relative URLs. Not enforced anywhere; see Q2 for the test.
- **`redirect-https` does what its name says.** The name is not the spec. Verify: `kubectl -n home get middleware redirect-https -o yaml`, and post-apply `curl -sI http://cloudcli.rmz.sh/health?q=1` must return `Location: https://cloudcli.rmz.sh/health?q=1` (path and query preserved).
- **The LB stays LAN-only.** Nothing checks that the router doesn't forward 443→192.168.0.184. If it does, you've published a JWT-gated PTY to the internet with no forward auth. Verify the router before applying.

## 2. Most likely wrong assumption + cheapest refutation

**"The frontend/backend are origin-agnostic."** Dev-oriented npm apps very often bake `http://host:3001` or a bare port into bundles or runtime settings. Cheapest refutation, runnable now, sending exactly the headers Traefik will forward:

```sh
curl -s -H 'Host: cloudcli.rmz.sh' http://192.168.0.43:3001/ | grep -nE 'http://|ws://|:3001'
```

Follow the `<script src>`s it references and grep those too. Any hit is a pre-apply kill (mixed content / wrong-origin WS on an https page). Companion test of the upgrade path itself:

```sh
curl -si -H 'Host: cloudcli.rmz.sh' -H 'Origin: https://cloudcli.rmz.sh' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  http://192.168.0.43:3001/ws | head -1
```

Expect `HTTP/1.1 101`. A 403/400 here means Host/Origin pinning, and you find out before touching the cluster.

Runner-up assumption: the phone resolves `cloudcli.rmz.sh` at all — Android "Private DNS" (DoT) silently bypasses Pi-hole's DHCP DNS. Only test that matters: open the URL in Chrome on the actual phone.

## 3. WebSocket survival

- **Mechanically fine.** One endpoint means no load-balancing/stickiness concerns. Traefik dials `192.168.0.43:3001` directly from a pod — the exact path you already measured 200 on. `Connection`/`Upgrade` pass through; upgraded connections are not buffered; `Host` is forwarded unchanged (passHostHeader default true); Traefik adds `X-Forwarded-Proto: https` et al.
- **The concrete killer: `respondingTimeouts.idleTimeout`, documented Traefik default 180s.** It applies to hijacked/upgraded connections: 180 seconds with zero bytes in either direction and Traefik closes the connection. A PTY sitting at a prompt or an idle chat hits exactly that. Whether CloudCLI sends WS keepalives: I don't know — measure it: open `/shell`, type nothing for 4 minutes, see if it freezes. Check for overrides with `kubectl -n kube-system get helmchartconfig` (plus the traefik HelmChart values); if nothing sets `respondingTimeouts`, the default governs. `readTimeout` (default 60s) governs reading the request pre-upgrade; I don't know whether it plays any role post-hijack in your Traefik version, so I won't guess. Fixing it means a HelmChartConfig (`ports.websecure.transport.respondingTimeouts.idleTimeout: 0`) — note that modifies existing Traefik, i.e. the change stops being purely additive. Alternative: app-level ping under 180s.
- **The redirect is not in the https path**, so it doesn't touch wss. But anything that ever derives `ws://` (a stale http-cached page) is not redirected — browsers hard-fail a WS handshake returning 3xx (RFC 6455: anything but 101 fails). Symptom: chat silently never connects instead of following the redirect.
- Off-config reality: Android doze and Wi-Fi handoffs will kill long-lived WS regardless; reconnect logic has to exist app-side or it will *look* like this config's fault.

## 4. PWA / service worker / push

- Secure context is satisfied on `https://cloudcli.rmz.sh` (valid LE wildcard). It is **not** satisfied on `https://cloudcli.k8s.lan` — cert mismatch means no SW, no install, no push there, and your http route actively redirects people into it. That's the one manifest-level degradation.
- Host header: backend sees `Host: cloudcli.rmz.sh` (no port, 443 implied). URLs built from `Host` are correct; URLs built from the app's listen port or a configured base URL are wrong. The Q2 grep is the test.
- `window.location`-derived WS URL is correct iff the scheme detection is `location.protocol`-based, not hardcoded — same grep.
- **Manifest scope**: fine iff the manifest is served at root or declares `"scope": "/"`. If it lives at a subpath (e.g. `/assets/manifest.webmanifest`) without an explicit scope, SW registration fails with "outside of the maximum allowed scope" and the whole PWA story dies quietly. Check the `<link rel="manifest">` target with the Host-header curl and read `start_url`/`scope`. I don't know where this fork serves it.
- Push: subscriptions are per-origin, so the new origin just needs one fresh subscribe (VAPID keys are server-side, unaffected). Environment degradations, not manifest bugs: (a) Private DNS bypassing Pi-hole → name doesn't resolve on the phone at all; (b) off-Wi-Fi the origin points at 192.168.0.184, so FCM may deliver but the SW's fetch to the server fails — notifications are effectively LAN-only; (c) the old origin's localStorage/JWT don't migrate — expect a one-time re-login that looks like a logout bug.
- TWA later needs `/.well-known/assetlinks.json` served by the app; the path proxies fine, but verify the app serves it.

## 5. Actually wrong, not stylistic

1. **`cloudcli.k8s.lan` on the websecure route is a defect**: served a `*.rmz.sh` cert it can't match, with the http route funneling traffic into the error. Drop the host from both routes, or terminate `.lan` with its own cert.
2. **Nothing anywhere health-checks this backend.** Static `ready: true` plus DHCP plus an unmanaged process means the system can 502 indefinitely while reporting healthy. Reservation + systemd unit + (at minimum) an external uptime probe with an alert.
3. **Port 3001 stays open on `0.0.0.0`**, bypassing TLS and every middleware you might add later. If Traefik is meant to be the front door, firewall 3001 to the K3s nodes only.
4. **Unverified router exposure of 443→.184** — see Q1. Verify before applying.
5. **Registration race**: if the first user doesn't exist yet, the first LAN actor to hit the new URL claims a 7-day-JWT PTY on your workstation. Confirm registration is already closed before this goes live.
6. **"Purely additive" doesn't survive contact with requirement**: if `/shell` must idle, you need either the Traefik `respondingTimeouts` change (modifies the cluster) or an app keepalive. Make that decision explicitly, now, not after the phone terminal freezes at minute three.

Nothing here needs a number I haven't given you except the 180s/60s documented defaults above, and the only ones worth trusting are the ones you re-verify against the effective Traefik config in this cluster.
