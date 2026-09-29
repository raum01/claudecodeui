#!/usr/bin/env bash
#
# Headless Android emulator for verifying the CloudCLI Trusted Web Activity.
#
# There is no physical Android device on this workstation, so this emulator is
# the only place the TWA can actually be installed and looked at. The emulator
# runs with no window, so it works over SSH and inside an agent session; you
# observe it through `adb exec-out screencap`.
#
# Subcommands:
#   start   boot the AVD headless (creates it first if it does not exist) and
#           block until sys.boot_completed=1, then print the device properties
#   stop    ask the emulator to shut down, wait for the process to disappear
#   status  report whether it is running, what adb sees, and the boot props
#
# Environment overrides:
#   ANDROID_SDK_ROOT   default $HOME/Android/Sdk
#   AVD_NAME           default cloudcli-test
#   EMULATOR_PORT      default 5554 (adb serial becomes emulator-5554)
#   EMULATOR_DNS       optional, e.g. "8.8.8.8,1.1.1.1". Left unset the
#                      emulator derives DNS from the host resolver, which on a
#                      systemd-resolved box means the 127.0.0.53 stub. That
#                      works here, but set this if name resolution inside the
#                      guest ever fails.
#   BOOT_TIMEOUT       seconds to wait for sys.boot_completed, default 300
#   WIPE_DATA=1        boot with -wipe-data (fresh userdata partition)

set -euo pipefail

ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}"
export ANDROID_SDK_ROOT
export ANDROID_HOME="$ANDROID_SDK_ROOT"

AVD_NAME="${AVD_NAME:-cloudcli-test}"
EMULATOR_PORT="${EMULATOR_PORT:-5554}"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-300}"
SYSTEM_IMAGE="${SYSTEM_IMAGE:-system-images;android-34;google_apis_playstore;x86_64}"
DEVICE_PROFILE="${DEVICE_PROFILE:-pixel_6}"

SERIAL="emulator-${EMULATOR_PORT}"
ADB="$ANDROID_SDK_ROOT/platform-tools/adb"
EMULATOR="$ANDROID_SDK_ROOT/emulator/emulator"
AVDMANAGER="$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/avdmanager"

RUN_DIR="${XDG_RUNTIME_DIR:-/tmp}/cloudcli-emulator"
PID_FILE="$RUN_DIR/$AVD_NAME.pid"
LOG_FILE="$RUN_DIR/$AVD_NAME.log"

log() { printf '[emulator.sh] %s\n' "$*" >&2; }
die() { printf '[emulator.sh] ERROR: %s\n' "$*" >&2; exit 1; }

require_tools() {
  [ -x "$ADB" ] || die "adb not found at $ADB — install platform-tools with sdkmanager"
  [ -x "$EMULATOR" ] || die "emulator not found at $EMULATOR — install the emulator package with sdkmanager"
}

emulator_pid() {
  # The recorded pid is only trusted if that pid is still our emulator.
  [ -f "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE")"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  grep -qa 'emulator' "/proc/$pid/cmdline" 2>/dev/null || return 1
  printf '%s' "$pid"
}

CREATED_AVD=""

create_avd_if_missing() {
  CREATED_AVD=""
  if "$AVDMANAGER" list avd -c 2>/dev/null | grep -qx "$AVD_NAME"; then
    log "AVD $AVD_NAME already exists"
    return 0
  fi
  CREATED_AVD=1
  log "creating AVD $AVD_NAME from $SYSTEM_IMAGE ($DEVICE_PROFILE)"
  echo no | "$AVDMANAGER" create avd \
    --name "$AVD_NAME" \
    --package "$SYSTEM_IMAGE" \
    --device "$DEVICE_PROFILE" \
    --force >/dev/null

  # A stock Pixel AVD is given 1.5 GB and a 2 GB userdata partition, which is
  # cramped for a Play image plus an installed app. This box has 46 GB, so
  # raise both rather than debug low-memory flakiness later.
  local cfg="$HOME/.android/avd/$AVD_NAME.avd/config.ini"
  {
    echo 'hw.ramSize=4096'
    echo 'disk.dataPartition.size=6G'
    echo 'hw.gpu.enabled=yes'
    echo 'hw.gpu.mode=swiftshader_indirect'
    echo 'hw.keyboard=yes'
  } >> "$cfg"
}

cmd_start() {
  require_tools
  if emulator_pid >/dev/null; then
    log "already running as pid $(emulator_pid), serial $SERIAL"
    cmd_status
    return 0
  fi

  mkdir -p "$RUN_DIR"

  # Order matters. A google_apis_playstore image ships with ro.adb.secure=1, so
  # adb refuses to talk to it until the host's public key is in the guest's
  # /data/misc/adb/adb_keys. The emulator copies $HOME/.android/adbkey.pub in
  # there while userdata is being laid down, so the key has to exist *before*
  # the emulator launches. adb generates it on first start-server. Booting
  # first and starting adb second leaves the device permanently
  # "unauthorized", and there is no window to click the trust dialog in.
  "$ADB" start-server >/dev/null 2>&1 || true
  [ -f "$HOME/.android/adbkey.pub" ] || die "adb did not generate $HOME/.android/adbkey.pub"

  local fresh_avd=""
  create_avd_if_missing && fresh_avd="$CREATED_AVD"

  local wipe_args=()
  if [ -n "${WIPE_DATA:-}" ] || [ -n "$fresh_avd" ]; then
    # A newly created AVD, or an explicit request. Wiping is also the only
    # recovery when userdata was written before the adb key existed.
    log "booting with -wipe-data so the adb key is installed into userdata"
    wipe_args=(-wipe-data)
  fi

  local dns_args=()
  if [ -n "${EMULATOR_DNS:-}" ]; then
    dns_args=(-dns-server "$EMULATOR_DNS")
  fi

  log "booting $AVD_NAME headless on port $EMULATOR_PORT (log: $LOG_FILE)"
  nohup "$EMULATOR" -avd "$AVD_NAME" \
    -port "$EMULATOR_PORT" \
    -no-window -no-audio -no-boot-anim \
    -gpu swiftshader_indirect \
    -accel on \
    "${wipe_args[@]}" "${dns_args[@]}" \
    >"$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  log "emulator pid $(cat "$PID_FILE")"


  local deadline=$(( SECONDS + BOOT_TIMEOUT ))
  local booted=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! emulator_pid >/dev/null; then
      log "emulator process died. Last 40 lines of $LOG_FILE:"
      tail -40 "$LOG_FILE" >&2
      die "emulator exited before boot completed"
    fi
    if [ "$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
      booted=1
      break
    fi
    sleep 3
  done

  [ -n "$booted" ] || die "sys.boot_completed did not become 1 within ${BOOT_TIMEOUT}s (see $LOG_FILE)"

  # Boot completing does not mean the launcher has settled; package manager
  # still refuses installs for a few seconds after. Wait for it explicitly.
  "$ADB" -s "$SERIAL" wait-for-device >/dev/null
  until [ "$("$ADB" -s "$SERIAL" shell getprop init.svc.bootanim 2>/dev/null | tr -d '\r')" = "stopped" ]; do
    sleep 2
  done

  log "boot complete"
  cmd_status
}

cmd_stop() {
  require_tools
  local pid
  if ! pid="$(emulator_pid)"; then
    log "not running"
    rm -f "$PID_FILE"
    return 0
  fi

  log "stopping $SERIAL (pid $pid)"
  "$ADB" -s "$SERIAL" emu kill >/dev/null 2>&1 || true

  local deadline=$(( SECONDS + 60 ))
  while [ "$SECONDS" -lt "$deadline" ] && kill -0 "$pid" 2>/dev/null; do
    sleep 1
  done

  if kill -0 "$pid" 2>/dev/null; then
    log "did not exit on request, sending TERM"
    kill -TERM "$pid" 2>/dev/null || true
    sleep 5
    kill -KILL "$pid" 2>/dev/null || true
  fi

  rm -f "$PID_FILE"
  log "stopped"
}

cmd_status() {
  require_tools
  local pid
  if pid="$(emulator_pid)"; then
    echo "state:    running (pid $pid)"
  else
    echo "state:    not running"
  fi
  echo "avd:      $AVD_NAME"
  echo "serial:   $SERIAL"
  echo "sdk:      $ANDROID_SDK_ROOT"
  echo "log:      $LOG_FILE"
  echo "--- adb devices ---"
  "$ADB" devices -l
  if [ "$("$ADB" -s "$SERIAL" get-state 2>/dev/null)" = "device" ]; then
    echo "--- device properties ---"
    for prop in ro.build.version.release ro.build.version.sdk ro.product.cpu.abi \
                ro.product.model sys.boot_completed; do
      printf '%-32s %s\n' "$prop" "$("$ADB" -s "$SERIAL" shell getprop "$prop" | tr -d '\r')"
    done
    printf '%-32s %s\n' "global http_proxy" \
      "$("$ADB" -s "$SERIAL" shell settings get global http_proxy | tr -d '\r')"
  fi
}

case "${1:-}" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  *)
    cat >&2 <<EOF
usage: $(basename "$0") {start|stop|status}

  start   create the AVD if needed, boot it headless, wait for
          sys.boot_completed and a settled boot animation, then print
          adb devices and the key device properties
  stop    ask the emulator to shut down, escalating to TERM/KILL if it
          refuses, and clear the pid file
  status  print whether the emulator is running, what adb sees, and the
          device properties including whether an http proxy is set
EOF
    exit 2
    ;;
esac
