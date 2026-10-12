#!/bin/bash
# Mounts or unmounts one Windows folder in Grunt's sandbox distro (spec
# 2026-10-12-sandbox-design, "Folders in the VM"). Grunt runs it as root:
#   wsl.exe -d grunt-sandbox -u root --exec /opt/grunt-sandbox/mount.sh ...
# The model never can: the grunt user has no sudo, and this file is root's.
#
#   mount.sh mount   'X:\a\b' /mnt/x/a/b ro|rw
#   mount.sh unmount 'X:\a\b' /mnt/x/a/b
#
# It checks its own arguments, so it can only ever put a drive-letter folder
# at /mnt/<drive>/<the same path>: never a device, a network path or anywhere
# else. `mount` is idempotent: a target that is already mounted in the same
# mode is left alone (another chat's command may be running in it), and only
# a mode change unmounts and mounts again.
#
# GRUNT_MOUNT_DRY_RUN=1 prints the commands instead of running them;
# GRUNT_MOUNT_DRY_RUN_MOUNTED=ro|rw then pretends the target is mounted so.
set -euo pipefail

die() { printf 'mount.sh: %s\n' "$*" >&2; exit 2; }
dry() { [ "${GRUNT_MOUNT_DRY_RUN:-}" = 1 ]; }
run() {
  if dry; then printf '%s|' "$@"; printf '\n'; else "$@"; fi
}

[ "$#" -ge 3 ] || die 'usage: mount.sh mount|unmount <windows path> <linux path> [ro|rw]'
action=$1
win=$2
target=$3
mode=${4:-}

case "$action" in
  mount|unmount) ;;
  *) die "unknown action: $action" ;;
esac

cntrl='[[:cntrl:]]'
if [[ "$win" =~ $cntrl || "$target" =~ $cntrl ]]; then die 'a path contains control characters'; fi

drive_re='^[A-Za-z]:\\'
[[ "$win" =~ $drive_re ]] || die "not a drive-letter path: $win"
[[ "$win" != */* ]] || die "use backslashes in the Windows path: $win"

rest=${win:3}
[[ "$rest" != *'\' ]] || die "trailing separator: $win"
if [ -n "$rest" ]; then
  IFS='\' read -r -a parts <<< "$rest"
  for part in "${parts[@]}"; do
    [[ -n "$part" && "$part" != '.' && "$part" != '..' ]] || die "bad path segment in $win"
  done
fi

drive=$(printf '%s' "${win:0:1}" | tr 'A-Z' 'a-z')
expected="/mnt/$drive"
[ -z "$rest" ] || expected="$expected/${rest//\\//}"
[ "$target" = "$expected" ] || die "target $target doesn't match $win (expected $expected)"

# The mode the target is mounted in now (ro or rw), or empty if it isn't mounted.
mounted_mode() {
  if dry; then
    printf '%s' "${GRUNT_MOUNT_DRY_RUN_MOUNTED:-}"
  elif mountpoint -q "$target"; then
    local options
    options=$(findmnt -n -o OPTIONS --mountpoint "$target" || true)
    printf '%s' "${options%%,*}"
  fi
}

if [ "$action" = mount ]; then
  case "$mode" in
    ro|rw) ;;
    *) die "mode must be ro or rw, not '$mode'" ;;
  esac
  current=$(mounted_mode)
  # Already there in this mode: leave it alone, a command may be running in it.
  [ "$current" != "$mode" ] || exit 0
  if dry; then
    uid=UID
    gid=GID
  else
    uid=$(id -u grunt)
    gid=$(id -g grunt)
  fi
  # Mounted in the other mode: start clean.
  if [ -n "$current" ]; then run umount "$target"; fi
  run mkdir -p "$target"
  run mount -t drvfs "$win" "$target" -o "$mode,uid=$uid,gid=$gid"
else
  if ! dry && ! mountpoint -q "$target"; then exit 0; fi
  run umount "$target"
fi
