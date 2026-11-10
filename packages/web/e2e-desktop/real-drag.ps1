# A drag with the real mouse, for desktop.spec.ts. Playwright's own dragTo is
# synthesised inside Chromium and never reaches Windows' OLE drag and drop, so it
# passes even when WebView2's drop handler would swallow the drop; this moves the
# cursor and presses the button as a person does.
#
# The window is the top-level window of process -AppPid titled -Title (never
# found by title alone: an installed OtherBench has the same one). It is made
# topmost for the drag and put back after. Coordinates are in the window's client
# area, in physical pixels. Exit codes: 0 done, 2 no such window, 3 another
# window is under a point.
param(
  [Parameter(Mandatory)] [int] $AppPid,
  [Parameter(Mandatory)] [string] $Title,
  [Parameter(Mandatory)] [int] $FromX,
  [Parameter(Mandatory)] [int] $FromY,
  [Parameter(Mandatory)] [int] $ToX,
  [Parameter(Mandatory)] [int] $ToY
)
$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class E2EDrag {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

  public static IntPtr Find(uint pid, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hwnd, _) => {
      uint owner;
      GetWindowThreadProcessId(hwnd, out owner);
      if (owner != pid || !IsWindowVisible(hwnd)) return true;
      var text = new StringBuilder(256);
      GetWindowText(hwnd, text, text.Capacity);
      if (text.ToString() != title) return true;
      found = hwnd;
      return false;
    }, IntPtr.Zero);
    return found;
  }
}
'@

# Physical pixels throughout (per-monitor aware v2).
[void][E2EDrag]::SetThreadDpiAwarenessContext([IntPtr]-4)

$hwnd = [E2EDrag]::Find([uint32]$AppPid, $Title)
if ($hwnd -eq [IntPtr]::Zero) { Write-Error "No visible window '$Title' in process $AppPid."; exit 2 }

$NOSIZE_NOMOVE = 0x0001 -bor 0x0002
$TOPMOST = [IntPtr]-1
$NOTOPMOST = [IntPtr]-2
$origin = New-Object E2EDrag+POINT
[void][E2EDrag]::ClientToScreen($hwnd, [ref]$origin)
$from = New-Object E2EDrag+POINT -Property @{ X = $origin.X + $FromX; Y = $origin.Y + $FromY }
$to = New-Object E2EDrag+POINT -Property @{ X = $origin.X + $ToX; Y = $origin.Y + $ToY }

$saved = New-Object E2EDrag+POINT
[void][E2EDrag]::GetCursorPos([ref]$saved)
[void][E2EDrag]::SetWindowPos($hwnd, $TOPMOST, 0, 0, 0, 0, $NOSIZE_NOMOVE)
$code = 0
try {
  Start-Sleep -Milliseconds 300
  foreach ($p in @($from, $to)) {
    $root = [E2EDrag]::GetAncestor([E2EDrag]::WindowFromPoint($p), 2)
    if ($root -ne $hwnd) { [Console]::Error.WriteLine("Another window is under ($($p.X), $($p.Y))."); $code = 3 }
  }
  if ($code -eq 0) {
    $LEFTDOWN = 0x0002; $LEFTUP = 0x0004
    [void][E2EDrag]::SetCursorPos($from.X, $from.Y)
    Start-Sleep -Milliseconds 150
    [E2EDrag]::mouse_event($LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 150
    # Past the drag threshold first, then on to the target in steps, as a hand does.
    for ($i = 1; $i -le 5; $i++) { [void][E2EDrag]::SetCursorPos($from.X + 2 * $i, $from.Y + 2 * $i); Start-Sleep -Milliseconds 40 }
    $startX = $from.X + 10; $startY = $from.Y + 10
    $steps = 25
    for ($i = 1; $i -le $steps; $i++) {
      $x = [int]($startX + ($to.X - $startX) * $i / $steps)
      $y = [int]($startY + ($to.Y - $startY) * $i / $steps)
      [void][E2EDrag]::SetCursorPos($x, $y)
      Start-Sleep -Milliseconds 40
    }
    Start-Sleep -Milliseconds 300
    [E2EDrag]::mouse_event($LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 300
  }
} finally {
  [void][E2EDrag]::SetWindowPos($hwnd, $NOTOPMOST, 0, 0, 0, 0, $NOSIZE_NOMOVE)
  [void][E2EDrag]::SetCursorPos($saved.X, $saved.Y)
}
exit $code
