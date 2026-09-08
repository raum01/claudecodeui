# PROGRESS

Fork of CloudCLI UI (https://github.com/siteboon/claudecodeui), maintained for
the raum homelab. Upstream base: `main` @ `7015ffc` (2026-09-07).

## Live plan

**[docs/plans/2026-09-08-cloudcli-android-access.md](docs/plans/2026-09-08-cloudcli-android-access.md)**
— reach the workstation's CloudCLI server from Android: HTTPS via the existing
`*.rmz.sh` certificate, installable PWA, then a TWA APK.

Current position: steps 1 and 2 done, `https://cloudcli.rmz.sh` is live and
serving 200 with a trusted certificate. Step 0 (the GitHub fork) is blocked
on `gh auth login`. Step 3 needs a phone.

Read the plan first. Do not re-derive its findings.

## Branches

- `main` — tracks `upstream/main`, no local commits.
- `homelab/android-access` — this work.
