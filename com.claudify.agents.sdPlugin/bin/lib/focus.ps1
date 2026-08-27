# Raise the terminal window a Claude Code session is running in.
#
# Windows Terminal puts the active tab's title in its window title, and Claude
# Code names a session after its task -- so the session names from
# `claude agents --json` are usually enough to find the right window. Any
# leftover terminal window is the fallback.
#
# The script is handed over as -EncodedCommand rather than run from a path, so it
# behaves the same whether the plugin sits on the Windows filesystem or is being
# driven from WSL during development. `-Command -` cannot be used: it chokes on
# the here-string below. launch.js substitutes the names list.
#
# Prints exactly one line: "raised: <title>", "failed: <title>", or "none".
$Names = __NAMES__

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

# A session name in the title is the strongest signal; a terminal process is the
# fallback, ranked by how likely it is to be the one in use.
$target = $null
foreach ($name in $Names) {
  if (-not $name) { continue }
  $target = $windows | Where-Object { $_.Title -like ('*' + $name + '*') } | Select-Object -First 1
  if ($target) { break }
}
if (-not $target) {
  foreach ($terminal in $terminals) {
    $target = $windows | Where-Object { $_.Process -eq $terminal } | Select-Object -First 1
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
