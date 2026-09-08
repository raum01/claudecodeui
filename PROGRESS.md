# PROGRESS

Fork of CloudCLI UI (https://github.com/siteboon/claudecodeui), maintained for
the raum homelab. Upstream base: `main` @ `7015ffc` (2026-09-07).

## Live plan

**[docs/plans/2026-09-08-cloudcli-android-access.md](docs/plans/2026-09-08-cloudcli-android-access.md)**
— reach the workstation's CloudCLI server from Android: HTTPS via the existing
`*.rmz.sh` certificate, installable PWA, then a TWA APK.

Current position: steps 0, 1 and 2 done. `https://cloudcli.rmz.sh` is live and
serving 200 with a trusted certificate, and this branch is pushed to the fork.
Step 3 needs a phone and is the gate before the APK.

Read the plan first. Do not re-derive its findings.

## Branches

- `main` — tracks `upstream/main`, no local commits. Deliberate: this fork
  consumes upstream rather than diverging from it, so `git pull` on `main`
  fetches siteboon, not our own copy.
- `homelab/android-access` — this work, tracks `origin`.

`origin` is https://github.com/raum01/claudecodeui. `upstream` is siteboon's,
fetch-only: its push URL is set to a non-existent host on purpose.

Commits here use `8431022+raum01@users.noreply.github.com`, not the personal
address, because this fork is public.
