#!/bin/sh
# Is Windows interop off in this distro? Run by setup (as root) and by the self-test (as grunt, inside
# the sandbox runtime). Prints "interop-off" and exits 0 only when nothing it tried could start a Windows
# program. Exits 3 when it saw interop on, and 4 when it couldn't tell (couldn't test, or an outcome it
# doesn't recognise); both fail setup and the self-test.
#
# This is evidence, not the barrier: the barrier is /etc/wsl.conf ([interop] enabled=false), which only
# root can change. A WSLInterop registration can be visible here even with interop off, because WSL
# distros share one kernel and another distro (Docker Desktop's, say) registers it; so the check doesn't
# look for the registration. It tries to start a Windows program: once as it is, and once pointed at each
# socket under /run/WSL, since a command can set WSL_INTEROP itself. Only two failures are accepted, as
# seen with interop off on WSL 2.7.3 (2026-10-14):
#   - the shell's own refusal, "<script>: <line>: <program>: Exec format error", exit 126: no interop
#     registration was active, so the kernel refused the file. That exercises nothing beyond the kernel,
#     and the script says so ("note: no-registration").
#   - WSL's "UtilAcceptVsock ... accept4 failed", exit 1, after about 10 s: a registration was active and
#     its handler waited for Windows, which never answered for this distro. Interop on can produce this
#     too when Windows is slow to answer; the attempts through each socket are what separate on from off.
# With interop on, Windows answers at once ("<program>: Invalid argument" for this file), which counts as
# reached, as does a success. Running /init directly isn't tried: it exits 1 silently with interop on or
# off (checked on both), so it tells nothing and starts nothing. Re-check these texts after WSL updates;
# a changed text fails closed (exit 4).

case ":$PATH:" in
  */mnt/*) echo "INTEROP-REACHED: Windows folders are on PATH ($PATH)"; exit 3 ;;
esac
if [ -n "${WSL_INTEROP-}" ]; then
  echo "INTEROP-REACHED: WSL_INTEROP is set ($WSL_INTEROP)"
  exit 3
fi

dir=$(mktemp -d "${TMPDIR:-/tmp}/grunt-interop.XXXXXX") || { echo "INTEROP-UNKNOWN: couldn't make a temp folder to test with"; exit 4; }
probe="$dir/probe.exe"
# "MZ" is what WSL's interop registration matches; the rest makes it a file Windows can't run.
if ! printf 'MZ\000\000' > "$probe" || ! chmod 700 "$probe"; then
  rm -rf "$dir"
  echo "INTEROP-UNKNOWN: couldn't write the test program"
  exit 4
fi

reached=''
unknown=''
refused_by_kernel=0
try() {
  # $1: the WSL_INTEROP value to try, or empty for none.
  if [ -n "$1" ]; then out=$(WSL_INTEROP="$1" "$probe" </dev/null 2>&1); else out=$("$probe" </dev/null 2>&1); fi
  code=$?
  how="running a Windows program${1:+ with WSL_INTEROP=$1}"
  case "$code:$out" in
    126:*[0-9]": $probe: Exec format error") refused_by_kernel=$((refused_by_kernel + 1)) ;;
    1:*"UtilAcceptVsock"*"accept4 failed"*) ;;
    0:*) reached="$how succeeded: $out" ;;
    *"$probe: Invalid argument"*) reached="$how reached Windows (exit $code): $out" ;;
    *) unknown="$how gave exit $code: $out" ;;
  esac
}

try ''
sockets=0
for socket in /run/WSL/*; do
  [ -S "$socket" ] || continue
  sockets=$((sockets + 1))
  # More sockets than a distro has (each attempt can take about 10 s): don't guess, say it couldn't tell.
  if [ "$sockets" -gt 8 ]; then unknown="more than 8 sockets under /run/WSL"; break; fi
  try "$socket"
done
rm -rf "$dir"

if [ -e /proc/sys/fs/binfmt_misc/WSLInterop ] || [ -e /proc/sys/fs/binfmt_misc/WSLInterop-late ]; then
  echo "note: a WSLInterop registration is visible (WSL distros share one kernel, so it can be another distro's)"
fi
[ "$refused_by_kernel" -gt 0 ] && echo "note: no-registration (an attempt was refused by the kernel, before any interop handler)"

if [ -n "$reached" ]; then echo "INTEROP-REACHED: $reached"; exit 3; fi
if [ -n "$unknown" ]; then echo "INTEROP-UNKNOWN: $unknown"; exit 4; fi
echo interop-off
exit 0
