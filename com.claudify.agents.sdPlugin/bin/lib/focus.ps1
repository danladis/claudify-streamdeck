# Raise the window a Claude Code session is running in.
#
# Each target is @{ Title; Process }, best first -- see launch.js's
# focusTargets. Windows Terminal puts the active tab's title in its window
# title and Claude Code names a session after its task; VS Code puts the
# project folder in its window title, so a folder name against a `Code*`
# process finds the right editor window. An empty Title takes any window of
# that process, once every named target has come up empty. Any terminal window
# is the fallback -- unless every target named another process, because raising
# some terminal when the press asked for VS Code helps nobody.
#
# A press from inside one of the matched windows moves to the next one,
# wrapping around -- repeated presses cycle through the sessions' windows.
#
# The script is handed over as -EncodedCommand rather than run from a path, so it
# behaves the same whether the plugin sits on the Windows filesystem or is being
# driven from WSL during development. `-Command -` cannot be used: it chokes on
# the here-string below. launch.js substitutes the targets list.
#
# Prints exactly one line: "raised: <title>", "failed: <title>", or "none".
$Targets = __TARGETS__

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Fg {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);
}
'@

$SW_RESTORE = 9
$TOPMOST = New-Object IntPtr(-1)
$NOTOPMOST = New-Object IntPtr(-2)
$NOMOVE_NOSIZE_NOACTIVATE = 0x0001 -bor 0x0002 -bor 0x0010

# Terminal emulators worth falling back to, best first.
$terminals = @('WindowsTerminal', 'wezterm-gui', 'alacritty', 'ConEmu64', 'mintty', 'conhost', 'powershell', 'pwsh', 'cmd')

$windows = New-Object System.Collections.ArrayList
$callback = [Fg+EnumProc] {
  param($h, $p)
  if ([Fg]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][Fg]::GetWindowTextW($h, $sb, 512)
    $title = $sb.ToString()
    if ($title) {
      $procId = 0
      [Fg]::GetWindowThreadProcessId($h, [ref]$procId)
      $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
      [void]$windows.Add([pscustomobject]@{
        Handle = $h; Title = $title; Pid = $procId
        Process = if ($proc) { $proc.ProcessName } else { '' }
      })
    }
  }
  return $true
}
[void][Fg]::EnumWindows($callback, [IntPtr]::Zero)

# Every window a *named* target matches, in target order, each window once --
# the ring that repeated presses walk. Process-only targets (the "any VS Code
# window" last resort) stay out of it: they exist for the day a custom window
# title hides every name, and letting them in would drag session-less editor
# windows into the rotation.
$candidates = New-Object System.Collections.ArrayList
foreach ($t in $Targets) {
  if (-not $t.Title) { continue }
  foreach ($w in ($windows | Where-Object {
    ($_.Title -like ('*' + $t.Title + '*')) -and
    ((-not $t.Process) -or ($_.Process -like $t.Process))
  })) {
    if (-not ($candidates | Where-Object { $_.Handle -eq $w.Handle })) {
      [void]$candidates.Add($w)
    }
  }
}

# A terminal session whose name shows in no window title -- its tab is not the
# active one, or the shell writes its own titles -- must still be reachable from
# the ring, or a deck with both CLI and VS Code sessions would cycle through
# the editors only. When some target expected a terminal but no terminal window
# made the ring by name, the best terminal window joins it: one window, the
# same one the final fallback would raise, not every shell on the desktop.
$ringHasTerminal = @($candidates | Where-Object { $terminals -contains $_.Process }).Count -gt 0
$wantsTerminal = ($Targets.Count -eq 0) -or
  (@($Targets | Where-Object { -not $_.Process }).Count -gt 0)
if ($wantsTerminal -and (-not $ringHasTerminal)) {
  foreach ($terminal in $terminals) {
    $best = $windows | Where-Object { $_.Process -eq $terminal } | Select-Object -First 1
    if ($best) { [void]$candidates.Add($best); break }
  }
}

# A press lands on the best candidate. A press while already *in* a candidate
# moves to the one after it, wrapping -- so repeated presses cycle through the
# sessions' windows, and the first press is never wasted on where you are.
$target = $null
if ($candidates.Count -gt 0) {
  $target = $candidates[0]
  $front = [Fg]::GetForegroundWindow()
  for ($i = 0; $i -lt $candidates.Count; $i++) {
    if ($candidates[$i].Handle -eq $front) {
      $target = $candidates[($i + 1) % $candidates.Count]
      break
    }
  }
}

# Still nothing: a process-only target (the "any VS Code window" last resort).
# The terminal equivalent needs no twin here -- a wanted terminal window
# already joined the ring above.
if (-not $target) {
  foreach ($t in $Targets) {
    if ($t.Title -or (-not $t.Process)) { continue }
    $target = $windows | Where-Object { $_.Process -like $t.Process } | Select-Object -First 1
    if ($target) { break }
  }
}
if (-not $target) {
  Write-Output 'none'
  exit 1
}

# Windows refuses SetForegroundWindow to a process that is not already in front,
# so restore first, then bribe it with a brief topmost flip if the call fails.
[void][Fg]::AllowSetForegroundWindow($target.Pid)
if ([Fg]::IsIconic($target.Handle)) { [void][Fg]::ShowWindow($target.Handle, $SW_RESTORE) }

if (-not [Fg]::SetForegroundWindow($target.Handle)) {
  [void][Fg]::SetWindowPos($target.Handle, $TOPMOST, 0, 0, 0, 0, $NOMOVE_NOSIZE_NOACTIVATE)
  [void][Fg]::SetWindowPos($target.Handle, $NOTOPMOST, 0, 0, 0, 0, $NOMOVE_NOSIZE_NOACTIVATE)
  [void][Fg]::SetForegroundWindow($target.Handle)
}

if ([Fg]::GetForegroundWindow() -eq $target.Handle) {
  Write-Output ("raised: " + $target.Title)
  exit 0
}
Write-Output ("failed: " + $target.Title)
exit 2
