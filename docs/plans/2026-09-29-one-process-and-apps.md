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

- [x] A1. Study first. Done 2026-09-29 13:55-14:10 CDT.
      Root cause (code + live log, not a key mismatch): on the next message
      `queryClaudeSDK` first releases the held stdin, then `addSession` calls
      `interrupt()`. The SDK drops control requests written to an ended stdin
      (`ProcessTransport.write`: "Dropping write to ended stdin stream"), and the
      promise rejects only when that query is cleaned up. Live service log:
      "Error interrupting superseded run for session e6ca8f38...: Query closed
      before response received" at 13:17:49, 13:33:27 and 13:36:43, each the
      moment an old process finally exited. After EOF the CLI waits for its
      background agents (live ceiling 3 h via the bg-wait.conf drop-in) and runs
      their notification turns, so it outlived its replacement.
      Upstream `main` dc7cb6c6 does not fix it. #1291 and #1347 are in main and
      are the hold itself. Branch `fix/interrupt-a-busy-run...` (a17b7d4c) only
      touches scheduled messages; a variant of it is already in main. Open
      upstream PRs: #1395 (stop the old process's background tasks before the
      new turn; work is lost) and #1431 (Dredok, 2026-09-23: one query per
      conversation, next message pushed into the live CLI, turns matched by
      `result.user_message_uuid`). #1431 is exactly our target, so we adopted it
      (cherry-picked 2bc52574 and d84f8425 unchanged). Real CLI 2.1.281 echoes
      `user_message_uuid` (checked 14:03 CDT with a two-turn SDK script).
      Related issues: #1116 (same proposal, closed), #1325, #884.
- [x] A2. Reproduced in a test, red before the fix. 13:59 CDT.
      `server/modules/providers/tests/claude-one-process.test.ts`. Its fake CLI
      models the measured behaviours: EOF ends stdin; after EOF the CLI stays up
      while background work is outstanding; an interrupt after EOF is dropped.
      On upstream main: `not ok 1 - a message sent while background work holds
      the process goes into that process`, "turn 2 must not spawn a second CLI
      while the first is alive", expected 1, actual 2. The run also printed the
      live log line verbatim ("Error interrupting superseded run ... Query closed
      before response received").
- [x] A3. Fixed. Commit 2c7fb3a6 on `homelab/one-process`, pushed to `gitlab`
      and `origin` 14:57 CDT. It sits on top of the two #1431 commits
      (036ef651, a9ca060b).
      What #1431 left broken, fixed here, each with a test that failed or hung
      before:
      (1) `queryClaudeSDK` settled only when the process exited, which is now
      up to 30 min idle later. The AI commit message, the agent API and
      scheduled messages waited that long. It now settles when its own turn
      completes.
      (2) Runs without a session id (commit message) idled 30 min with all
      their MCP servers, about 1.6 GB per process on this box. They now exit
      when idle.
      (3) The restart path (edit, settings change) waited without a bound and
      ignored Stop. It now closes the old CLI after 10 s and skips an aborted
      turn.
      (4) Stop awaited an interrupt that can never be answered once stdin has
      ended. It now waits at most 5 s, then closes. The session entry is kept
      until the process exits, and that wait runs detached. Awaiting it made
      Stop show up as "exit 1, not aborted"; the live run caught this.
      (5) Permission retractions now go to the writer that showed the prompt.
      Verification: backend 604 tests, 603 pass, 1 skipped (with
      `CLAUDE_CLI_PATH` unset; with it inherited, 4 path tests fail on main
      too). Client 669 pass. `tsc -p server` and oxlint are clean. The one
      frontend typecheck error (recentConversationTitleSync.test.ts) is also
      on main.
      Review: GLM-5.3, two rounds. Accepted: the bounded interrupt, keeping
      the entry until exit, the pinned permission writer, the sessionless
      ceiling. Rejected after checking the code: the abortedInstances
      re-check, the startup TOCTOU, "close() is not a kill" (the SDK sends
      SIGTERM, then SIGKILL after 5 s), "result during interrupt", and "exit
      promise may reject". qwen3.8-max could not be asked (HTTP 403
      AccessDenied.Unpurchased at 14:25 CDT), so fewer reviewers looked at
      this.
- [x] A4. Proven live on a second instance. Port 3291, own database
      (`DATABASE_PATH=/tmp/oneproc-a4/data/auth.db`), clean environment, real
      HOME and real `claude` 2.1.281, model haiku, project
      /tmp/oneproc-a4/project. Final run 14:54:59-14:57:06 CDT, from the
      packed tarball (SDK 0.3.285, what the install will get):
      turn 1 started `sleep 60` in the background; turn 2 was sent while it
      ran; the completion came back as an automatic turn on turn 2's stream.
      One PID, 895998, for all of that: 104 one-second samples. Stop was
      reported as `complete exitCode 0 aborted true`, and no CLI was left 3 s
      later. The next message started exactly one new PID, 907257. No sample
      ever showed two CLIs. The server logged "Starting async generator loop"
      twice: one per process, one after the other. Earlier runs on the
      worktree build (14:18-14:20 and 14:44-14:47 CDT) matched; the 14:44 run
      found the Stop reporting bug fixed in (4).
      Deviation from the plan: HOME was not a scratch dir, because the CLI's
      OAuth credentials must not be copied (a refresh would rotate the owner's
      token). Only CloudCLI's own data was isolated. It overwrote
      `~/.cloudcli/local-server.json` (read only by the Electron app); that
      file was backed up and restored after each run to pid 4012 / port 3001.
      Test transcripts were written to ~/.claude/projects/-tmp-oneproc-a4-project.
- [ ] A5. Deploy to the live service. Prepared, not run. Restarting kills
      every running conversation, including the orchestrator's, so the owner
      or orchestrator picks the moment.
      Artifact: `/mnt/windata/scratch/cloudcli-one-process-20260929/cloudcli-ai-cloudcli-1.37.3-2c7fb3a6.tgz`
      (sha256 0c3a0589...3469, see SHA256SUMS there), built from 2c7fb3a6.
      Chosen method: install into a new release dir and point the unit at it
      with a drop-in. The old global install stays untouched for instant
      rollback, and nothing ever runs half old, half new. `npm install -g`
      over the running service would swap files under a live process. Running
      from the git worktree would mean production executes a dev checkout.
      ```sh
      # 1. install (no restart; the live service is unaffected)
      export PATH=/home/raum/.nvm/versions/node/v22.16.0/bin:$PATH
      R=/home/raum/.local/share/cloudcli-releases/2c7fb3a6
      mkdir -p $R && npm install --no-audit --no-fund --prefix $R \
        /mnt/windata/scratch/cloudcli-one-process-20260929/cloudcli-ai-cloudcli-1.37.3-2c7fb3a6.tgz
      grep -c settleInitialTurn $R/node_modules/@cloudcli-ai/cloudcli/dist-server/server/modules/providers/list/claude/claude-runtime.provider.js   # expect > 0
      # 2. point the unit at it (daemon-reload does not restart)
      cat > ~/.config/systemd/user/cloudcli.service.d/release.conf <<EOF
      [Service]
      ExecStart=
      ExecStart=/home/raum/.nvm/versions/node/v22.16.0/bin/node $R/node_modules/@cloudcli-ai/cloudcli/dist-server/server/modules/cli/cli.js start
      EOF
      systemctl --user daemon-reload
      systemctl --user cat cloudcli | grep ExecStart      # check before restarting
      # 3. the restart itself, at a chosen moment (kills all conversations)
      systemctl --user restart cloudcli
      # 4. verify
      systemctl --user show cloudcli -p MainPID -p ActiveState
      journalctl --user -u cloudcli -n 30 --no-pager
      readlink /proc/$(systemctl --user show cloudcli -p MainPID --value)/cwd
      ```
      After it: send two messages in one conversation while a background task
      runs and watch `ps -eo pid,ppid,args | awk '$2==<MainPID> && /stream-json/'`
      show one CLI. The log line "Error interrupting superseded run" should
      never appear again.
      Rollback: `rm ~/.config/systemd/user/cloudcli.service.d/release.conf &&
      systemctl --user daemon-reload && systemctl --user restart cloudcli`.
      That returns to the untouched global 1.37.3 plus the 2026-09-28 patch.
      Notes: `bg-wait.conf` (CLOUDCLI_BG_WAIT_CEILING_MS=10800000) is inert
      with the new code: the variable is no longer read, and the CLI never
      gets EOF while work is outstanding. Remove it after the deploy has
      settled. The UI's "Update" button or `npm install -g
      @cloudcli-ai/cloudcli` updates the global install, which the unit no
      longer runs, so an update needs a new release dir. The `cloudcli`
      command on PATH still points at the old global install.
      Behaviour change to expect: each conversation keeps its CLI and MCP
      servers alive for 30 min after its last turn (about 450 MB for the CLI
      plus about 1.2 GB for MCP children, measured on PID 540010 at 13:57
      CDT). Before, a CLI exited right after any turn without background
      work.
- [ ] A6. Upstream text drafted, not sent:
      `docs/upstream/2026-09-29-pr-1431-follow-up.md` on `homelab/one-process`.
      It is a follow-up comment for #1431 (the four fixes, the measured root
      cause, the live check) rather than a new issue, because #1431 already
      proposes the design. The owner decides whether to post it.

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
