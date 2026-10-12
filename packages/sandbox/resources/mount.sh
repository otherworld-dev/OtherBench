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
# Because it runs as root while the sandboxed `grunt` user can write to parts
# of the filesystem, it also walks every folder from /mnt down to the target
# before touching anything, and refuses a symbolic link or a folder grunt could
# swap for one: each must be root-owned and not group- or other-writable, or sit
# on a read-only mount (a child
# folder can be mounted rw inside a read-only drvfs parent, planMounts does
# that, and drvfs files there are owned by uid 1000 = grunt but can't be
# changed). Missing folders are created here, as root, one level at a time.
#
# GRUNT_MOUNT_DRY_RUN=1 prints the commands instead of running them, and
# simulates the filesystem, which has /mnt and nothing below it:
#   GRUNT_MOUNT_DRY_RUN_MOUNTED=ro|rw|<other>  the target exists and is mounted so
#                                              (anything but ro/rw: mode unreadable)
#   GRUNT_MOUNT_DRY_RUN_SYMLINK=<path>         that folder exists and is a symlink
#   GRUNT_MOUNT_DRY_RUN_GRUNT_OWNED=<path>     that folder exists, owned by grunt
#   GRUNT_MOUNT_DRY_RUN_WRITABLE=<path>        that folder exists, root-owned but group/other-writable
#   GRUNT_MOUNT_DRY_RUN_READONLY=1             ... and those two lie on a read-only mount
set -euo pipefail
export LC_ALL=C

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

# The rules for the Windows path, the same as parseMountable() in
# packages/core/src/domain/sandbox-paths.ts (test/fixtures/sandbox-path-vectors.json
# runs against both): X:\ then segments separated by single backslashes, no trailing
# one; a segment is not empty, not . or .., has no control character and none of
# < > : " / \ | ? * , ;, and doesn't end in a dot or a space; every byte >= 0x80 (UTF-8)
# is fine; at most 1024 bytes (LC_ALL=C, so ${#win} counts bytes).
for arg in "$action" "$win" "$target" "$mode"; do
  [[ "$arg" != -* ]] || die "an argument starts with '-': $arg"
done
# Spelled out: [[:cntrl:]] also matches 0x80-0x9f in some C locales (Cygwin's), and those are UTF-8 bytes.
cntrl=$'[\001-\037\177]'
if [[ "$win" =~ $cntrl || "$target" =~ $cntrl ]]; then die 'a path contains control characters'; fi
[ "${#win}" -le 1024 ] || die 'the Windows path is longer than 1024 bytes'

drive_re='^[A-Za-z]:\\'
[[ "$win" =~ $drive_re ]] || die "not a drive-letter path: $win"
[[ "$win" != */* ]] || die "use backslashes in the Windows path: $win"

rest=${win:3}
[[ "$rest" != *'\' ]] || die "trailing separator: $win"
forbidden='[<>:"|?*]'
trailing='[. ]$'
if [ -n "$rest" ]; then
  IFS='\' read -r -a parts <<< "$rest"
  for part in "${parts[@]}"; do
    [[ -n "$part" && "$part" != '.' && "$part" != '..' ]] || die "bad path segment in $win"
    [[ ! "$part" =~ $forbidden ]] || die "a character Windows doesn't allow in a name, in $win"
    [[ ! "$part" =~ $trailing ]] || die "a name ends in a dot or a space, in $win"
    # drvfs's mount option string can't carry these (and they would let a name add options).
    [[ "$part" != *[,\;]* ]] || die "commas and semicolons can't be mounted in the sandbox, in $win"
  done
fi

drive=$(printf '%s' "${win:0:1}" | tr 'A-Z' 'a-z')
expected="/mnt/$drive"
[ -z "$rest" ] || expected="$expected/${rest//\\//}"
[ "$target" = "$expected" ] || die "target $target doesn't match $win (expected $expected)"

is_mounted() {
  if dry; then [ -n "${GRUNT_MOUNT_DRY_RUN_MOUNTED:-}" ]; else mountpoint -q "$target"; fi
}

# The mode the target is mounted in now: ro, rw, "unknown" if it is mounted
# but the mode can't be read (treated as a mismatch), or empty if it isn't.
mounted_mode() {
  if ! is_mounted; then return 0; fi
  if dry; then printf '%s' "${GRUNT_MOUNT_DRY_RUN_MOUNTED:-}"; return 0; fi
  local options first
  options=$(findmnt -n -o OPTIONS --mountpoint "$target" || true)
  first=${options%%,*}
  case "$first" in
    ro|rw) printf '%s' "$first" ;;
    *) printf 'unknown' ;;
  esac
}

# --- what is on disk below /mnt (simulated in a dry run, see the header) ---
c_exists() {
  if dry; then
    [ "$1" = /mnt ] || [ -n "${GRUNT_MOUNT_DRY_RUN_MOUNTED:-}" ] || [ "$action" = unmount ] \
      || [ "$1" = "${GRUNT_MOUNT_DRY_RUN_SYMLINK:-}" ] || [ "$1" = "${GRUNT_MOUNT_DRY_RUN_GRUNT_OWNED:-}" ] \
      || [ "$1" = "${GRUNT_MOUNT_DRY_RUN_WRITABLE:-}" ]
  else
    [ -e "$1" ] || [ -L "$1" ]
  fi
}
c_symlink() {
  if dry; then [ "$1" = "${GRUNT_MOUNT_DRY_RUN_SYMLINK:-}" ]; else [ -L "$1" ]; fi
}
c_folder() {
  if dry; then return 0; fi
  [ -d "$1" ]
}
c_on_readonly_mount() {
  if dry; then [ "${GRUNT_MOUNT_DRY_RUN_READONLY:-}" = 1 ]; return; fi
  local options
  options=$(findmnt -n -o OPTIONS --target "$1" || true)
  [ "${options%%,*}" = ro ]
}
# True if the sandbox user can't change this folder: root owns it and neither its group nor
# everyone else can write to it, or it lies on a read-only mount.
c_trusted() {
  if dry; then
    if [ "$1" != "${GRUNT_MOUNT_DRY_RUN_GRUNT_OWNED:-}" ] && [ "$1" != "${GRUNT_MOUNT_DRY_RUN_WRITABLE:-}" ]; then return 0; fi
    c_on_readonly_mount "$1"
    return
  fi
  local owner perms
  owner=$(stat -c %u -- "$1")
  perms=$(stat -c %a -- "$1")
  perms="0000$perms"
  if [ "$owner" = 0 ] && (( (8#${perms: -2:1} & 2) == 0 && (8#${perms: -1} & 2) == 0 )); then return 0; fi
  c_on_readonly_mount "$1"
}

# Walks /mnt, /mnt/x, ... down to the target. Missing folders are created (mount only),
# one level at a time, and checked like the rest. Sets absent=1 if a folder isn't there
# (unmount: nothing to do). The target itself, when it is already a mount, is the mounted
# folder's own root and is owned by whoever the mount says; the rest must be trusted.
absent=0
check_path() {
  local p='' seg
  local -a segs
  IFS=/ read -r -a segs <<< "${target#/}"
  for seg in "${segs[@]}"; do
    p="$p/$seg"
    if ! c_exists "$p"; then
      if [ "$action" != mount ]; then absent=1; return 0; fi
      run mkdir -m 0755 -- "$p"
    fi
    if c_symlink "$p"; then die "$p is a symbolic link"; fi
    c_folder "$p" || die "$p is not a folder"
    if [ "$p" = "$target" ] && is_mounted; then continue; fi
    c_trusted "$p" || die "$p could be changed by the sandbox user"
  done
}

# The target must be exactly where the rule puts it once every link is resolved.
check_resolved() {
  if dry; then return 0; fi
  local real
  real=$(realpath -e -- "$target")
  [ "$real" = "$target" ] || die "$target resolves to $real"
}

if [ "$action" = mount ]; then
  case "$mode" in
    ro|rw) ;;
    *) die "mode must be ro or rw, not '$mode'" ;;
  esac
  check_path
  check_resolved
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
  # Mounted in the other mode, or in a mode we can't tell: take it off first, and
  # give up if it won't go (never stack a mount on it, never leave it wider than asked).
  if [ -n "$current" ]; then run umount -- "$target"; fi
  run mount -t drvfs -o "$mode,uid=$uid,gid=$gid" -- "$win" "$target"
else
  check_path
  [ "$absent" = 0 ] || exit 0
  check_resolved
  if ! dry && ! is_mounted; then exit 0; fi
  run umount -- "$target"
fi
