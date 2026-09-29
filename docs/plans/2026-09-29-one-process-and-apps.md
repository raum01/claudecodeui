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

- [ ] B1. Survey before building: what the upstream Electron app already does for a remote
      server (can it point at `cloudcli.rmz.sh`?), official CloudCLI mobile/desktop
      releases, and open-source Claude Code remote clients for Android and macOS.
      Decision table: reuse / adapt / build, with reasons.
- [ ] B2. Remote access from outside the home: how `cloudcli.rmz.sh` is reachable today
      (LAN only? Tailscale? Cloudflare?), and the proper way to reach it away from home
      without exposing an unauthenticated shell to the internet. Measured, not assumed.
- [ ] B3. Android: bring the TWA to current state (or replace it if B1 finds better);
      signed APK; notifications if feasible.
- [ ] B4. macOS: an app that opens our server; build it from Linux if the toolchain allows
      (unsigned zip/dmg), otherwise document exactly what needs a Mac.
- [ ] B5. Verify each client against the live server; evidence in the plan.

## Rules

- Parts A and B work in separate git worktrees; neither restarts the live `cloudcli`
  service.
- Commits on this public fork use `8431022+raum01@users.noreply.github.com`; nothing
  secret enters the repo (signing keys stay out, see 3b9c708).
- Push to both `gitlab` and `origin`.
