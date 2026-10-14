#!/bin/sh
# Is Windows interop off in this distro? Run by setup (as root) and by the self-test (as grunt, inside
# the sandbox runtime). Prints "interop-off" and exits 0 only when nothing can start a Windows program;
# anything else, including an outcome it doesn't recognise, prints INTEROP-REACHED and exits 3.
#
# A WSLInterop registration can be visible here even with interop off: WSL distros share one kernel,
# and another distro (Docker Desktop's, say) registers it. So this doesn't look for the registration.
# It tries to run a Windows program, once as it is and once pointed at each interop socket under
# /run/WSL (a command can set WSL_INTEROP itself), and accepts only the two failures seen when interop
# is off: "Exec format error" (nothing registered) or WSL's vsock accept failure (registered, but
# nothing answers for this distro). With interop on, Windows answers ("Invalid argument" for this
# file), which is refused here, as is a success.

case ":$PATH:" in
  */mnt/*) echo "INTEROP-REACHED: Windows folders are on PATH ($PATH)"; exit 3 ;;
esac
if [ -n "${WSL_INTEROP-}" ]; then
  echo "INTEROP-REACHED: WSL_INTEROP is set ($WSL_INTEROP)"
  exit 3
fi

dir=$(mktemp -d "${TMPDIR:-/tmp}/grunt-interop.XXXXXX") || { echo "INTEROP-REACHED: couldn't make a temp folder to test with"; exit 3; }
probe="$dir/probe.exe"
# "MZ" is what WSL's interop registration matches; the rest makes it a file Windows can't run.
if ! printf 'MZ\000\000' > "$probe" || ! chmod 700 "$probe"; then
  rm -rf "$dir"
  echo "INTEROP-REACHED: couldn't write the test program"
  exit 3
fi

verdict=interop-off
try() {
  # $1: the WSL_INTEROP value to try, or empty for none.
  if [ -n "$1" ]; then out=$(WSL_INTEROP="$1" "$probe" 2>&1); else out=$("$probe" 2>&1); fi
  code=$?
  case "$code:$out" in
    126:*"Exec format error"*) ;;
    *:*"UtilAcceptVsock"*"accept4 failed"*) ;;
    *) verdict="INTEROP-REACHED: running a Windows program${1:+ with WSL_INTEROP=$1} gave exit $code: $out" ;;
  esac
}

try ''
for socket in /run/WSL/*_interop; do
  [ -e "$socket" ] || continue
  try "$socket"
done
rm -rf "$dir"

if [ -e /proc/sys/fs/binfmt_misc/WSLInterop ] || [ -e /proc/sys/fs/binfmt_misc/WSLInterop-late ]; then
  echo "note: a WSLInterop registration is visible (WSL distros share one kernel, so it can be another distro's)"
fi
echo "$verdict"
[ "$verdict" = interop-off ] && exit 0
exit 3
