# CloudCLI for Android (Trusted Web Activity)

An Android app, package `sh.rmz.cloudcli`, that opens `https://cloudcli.rmz.sh`
full screen. It is a Trusted Web Activity built with
[bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap): the app carries no
browser engine of its own and runs the site in the phone's Chrome. So it shares
Chrome's storage, service worker and web push subscription with the installed
PWA, and it picks up every server upgrade without a rebuild.

History, decisions and evidence: `docs/plans/2026-09-08-cloudcli-android-access.md`
and `docs/plans/2026-09-29-one-process-and-apps.md` (Part B).

## What is tracked here

| file | role |
|---|---|
| `twa-manifest.json` | the app definition: package, host, colours, version, icon URLs |
| `generate-twa-manifest.js` | rewrites `twa-manifest.json` from the live web manifest, pinning package, host, names and signing alias. Run it only to pick up web-manifest changes |
| `generate-twa-project.js` | generates the Gradle project from `twa-manifest.json`; the non-interactive equivalent of `bubblewrap init` |
| `build.sh` | the whole build: generate, compile, sign, check against the live asset links |
| `emulator.sh` | headless Android emulator for checking the app without a phone |
| `package.json`, `package-lock.json` | pin `@bubblewrap/cli` 1.25.0 |

Everything else that appears in this directory (the Gradle project, `node_modules`,
`dist/`, screenshots) is generated and git-ignored.

## Build

```sh
./build.sh            # -> dist/cloudcli-<version>.apk
```

Needs bubblewrap's own toolchain in `~/.bubblewrap` (JDK 17 and an Android SDK;
bubblewrap refuses the system JDK 21) and the signing key below. The script signs
with `apksigner --ks-pass env:...` rather than letting bubblewrap sign, because
bubblewrap puts both passwords on the `apksigner` command line where `ps` can
read them. It then compares the signing certificate with the fingerprint served
at `https://cloudcli.rmz.sh/.well-known/assetlinks.json` and fails on a mismatch:
a mismatched app still installs, but opens with an address bar.

The build is reproducible. On 2026-09-29 it produced an APK byte-identical to the
one built on 2026-09-08 and installed on the owner's phone (SHA-256 `2c3699ee…`).

To ship a new version, raise `appVersionCode` (and `appVersionName`) in
`twa-manifest.json` and run `./build.sh`. Android only installs an update over the
existing app if the version code is higher and the signing key is the same.

## Signing key

`~/.android-keystores/cloudcli-twa.keystore`, alias `cloudcli`, passwords in
`~/.android-keystores/cloudcli-twa.credentials` (`keystore=`, `alias=`,
`storepass=`, `keypass=` lines). Neither file ever enters this repository.
Certificate SHA-256
`3B:95:85:B4:7E:D6:73:2A:9E:7A:A2:1D:C4:B2:4E:5B:40:9A:52:74:09:3E:52:37:33:60:3B:8B:87:88:70:A8`.

This key is the only thing that can ever update the installed app. If it is lost,
the app can only be uninstalled and replaced by one signed with a new key, and
the fingerprint in the cluster's `assetlinks.json` (kuber repo,
`k8s/home-services/apps/cloudcli/assetlinks.yaml`) has to change with it.
Keep a copy outside this machine.

## Reaching the server away from home

`cloudcli.rmz.sh` resolves, in public DNS too, to the Traefik gateway at the
private address `192.168.0.184`. At home that just works. Away from home the phone
needs Tailscale connected with "Use Tailscale subnets" on: the cluster's Tailscale
subnet router advertises `192.168.0.0/24`. Without either, Chrome shows its own
"site can't be reached" page inside the app.

## Checking it without a phone

```sh
./emulator.sh start
adb install -r dist/cloudcli-<version>.apk
adb shell monkey -p sh.rmz.cloudcli -c android.intent.category.LAUNCHER 1
sleep 20                                       # the first launch takes a while
adb shell dumpsys activity activities | grep -m1 topResumedActivity   # ...customtabs.CustomTabActivity
adb exec-out screencap -p > screen.png         # login page, no address bar
./emulator.sh stop
```

The screenshot is the test. Do not use `adb shell pm get-app-links sh.rmz.cloudcli`
as one: it reports `cloudcli.rmz.sh: 1024`, a verifier-defined failure, and that
is expected. Android's own App Links verifier goes through Google's Digital Asset
Links API, and Google's servers cannot fetch a file from a private address
(`assetlinks:check` returns `ERROR_CODE_FETCH_ERROR`, measured 2026-09-29).
Chrome's full-screen decision does not depend on it: on 2026-09-29 the app still
opened without an address bar after `pm clear com.android.chrome` wiped Chrome's
stored state.

Start the adb server before the emulator boots; the Play Store image enforces
adb authorisation and a headless device cannot show the prompt. `emulator.sh`
does this itself.
