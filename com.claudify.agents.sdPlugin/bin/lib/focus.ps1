# Raise the window a Claude Code session is running in.
#
# Each target is @{ Title; Process; Tab }, best first -- see launch.js's
# focusTargets. Windows Terminal puts the active tab's title in its window
# title; VS Code puts the project folder in its window title, so a folder name
# against a `Code*` process finds the right editor window. An empty Title takes
# any window of that process, once every named target has come up empty. Any
# terminal window is the fallback -- unless every target named another process,
# because raising some terminal when the press asked for VS Code helps nobody.
#
# Tab is what makes a *tabbed* terminal work. A terminal hosting six sessions
# is one window with one handle, so SetForegroundWindow can only ever raise the
# lot -- and the window title names the active tab alone, so a session sitting
# in a background tab matches nothing and the press lands on whatever tab
# happened to be in front. Tab names the session's own tab, found through UI
# Automation, which sees inside a window where the window APIs cannot. It is
# also the more reliable way in: searching tabs finds a session whether or not
# its tab is the active one, so a blocked session keeps its rank instead of
# falling behind whichever session is on top.
#
# A press from inside one of the matched windows moves to the next one,
# wrapping around -- repeated presses cycle through the sessions, tab by tab
# within a window as readily as window to window.
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

# UI Automation is how a tab is reached at all: it exposes a window's insides
# as elements, which is how a screen reader gets at a tab strip, and it ships
# with .NET on every Windows box. A machine that somehow has not got it loses
# tab selection and nothing else -- the press still raises the window.
$uiaReady = $false
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop
  $uiaReady = $true
} catch {
  $uiaReady = $false
}

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

# A window's tabs, asked for once. Walking the automation tree costs real
# milliseconds, and only terminal windows are ever asked -- an editor window
# has tabs too, but a VS Code session is already found by its window title, and
# every extra window walked is delay the press pays for.
$tabCache = @{}
function Get-Tabs($handle) {
  if ($tabCache.ContainsKey($handle)) { return @($tabCache[$handle]) }

  $tabs = @()
  if ($uiaReady) {
    try {
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
      $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::TabItem)
      foreach ($el in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
        $tabs += [pscustomobject]@{ Name = $el.Current.Name; Element = $el }
      }
    } catch {
      # A window that will not answer -- closing, elevated, or not really a
      # tabbed thing at all. No tabs is a perfectly good answer.
      $tabs = @()
    }
  }
  $tabCache[$handle] = $tabs
  return @($tabs)
}

# The tab whose name carries $title. A contains test, not an equals: Windows
# Terminal prefixes a status glyph onto the tab name Claude Code set, so the
# title is a substring of what the automation tree reports. Escaped for the
# same reason window titles are -- a task name is free text and a bare `[` in
# one would otherwise read as a character class.
function Find-Tab($handle, $title) {
  if (-not $title) { return $null }
  $pattern = '*' + [System.Management.Automation.WildcardPattern]::Escape($title) + '*'
  foreach ($tab in (Get-Tabs $handle)) {
    if ($tab.Name -like $pattern) { return $tab }
  }
  return $null
}

# Which tab a window is currently showing, so that "a press from where you
# already are moves on" can tell two tabs of one window apart.
function Get-SelectedTab($handle) {
  foreach ($tab in (Get-Tabs $handle)) {
    try {
      $pattern = $null
      if ($tab.Element.TryGetCurrentPattern(
            [System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
        if ($pattern.Current.IsSelected) { return $tab.Name }
      }
    } catch {
      # Gone since it was enumerated; the next one will do.
    }
  }
  return ''
}

# Every window a *named* target matches, in target order, each window once --
# the ring that repeated presses walk. Process-only targets (the "any VS Code
# window" last resort) stay out of it: they exist for the day a custom window
# title hides every name, and letting them in would drag session-less editor
# windows into the rotation.
# A candidate is a window and, where one is known, the tab within it -- two
# sessions sharing a terminal are two candidates on one handle, so the ring
# walks sessions rather than windows.
$candidates = New-Object System.Collections.ArrayList
function Add-Candidate($window, $tab, $urgency) {
  $name = if ($tab) { $tab.Name } else { '' }
  foreach ($existing in $candidates) {
    $seen = if ($existing.Tab) { $existing.Tab.Name } else { '' }
    if (($existing.Window.Handle -eq $window.Handle) -and ($seen -eq $name)) { return }
  }
  [void]$candidates.Add([pscustomobject]@{ Window = $window; Tab = $tab; Urgency = $urgency })
}

foreach ($t in $Targets) {
  # The tab first: it finds the session whether or not its tab is in front,
  # where the window title only ever names the active one.
  $matched = $false
  if ($t.Tab) {
    foreach ($w in ($windows | Where-Object { $terminals -contains $_.Process })) {
      $tab = Find-Tab $w.Handle $t.Tab
      if ($tab) {
        Add-Candidate $w $tab $t.Urgency
        $matched = $true
      }
    }
  }
  if ($matched -or (-not $t.Title)) { continue }

  # No tab found -- an untabbed emulator, a VS Code target, or a session whose
  # tab has been renamed. The window title is the other way in.
  $pattern = '*' + [System.Management.Automation.WildcardPattern]::Escape($t.Title) + '*'
  foreach ($w in ($windows | Where-Object {
    ($_.Title -like $pattern) -and
    ((-not $t.Process) -or ($_.Process -like $t.Process))
  })) {
    Add-Candidate $w $null $t.Urgency
  }
}

# A terminal session whose name shows in no window title -- its tab is not the
# active one, or the shell writes its own titles -- must still be reachable from
# the ring, or a deck with both CLI and VS Code sessions would cycle through
# the editors only. When some target expected a terminal but no terminal window
# made the ring by name, the best terminal window joins it: one window, the
# same one the final fallback would raise, not every shell on the desktop.
$ringHasTerminal =
  @($candidates | Where-Object { $terminals -contains $_.Window.Process }).Count -gt 0
$wantsTerminal = ($Targets.Count -eq 0) -or
  (@($Targets | Where-Object { -not $_.Process }).Count -gt 0)
if ($wantsTerminal -and (-not $ringHasTerminal)) {
  foreach ($terminal in $terminals) {
    $best = $windows | Where-Object { $_.Process -eq $terminal } | Select-Object -First 1
    if ($best) { Add-Candidate $best $null 9; break }
  }
}

# A press lands on the best candidate. A press while already *in* a candidate
# moves to the one after it, wrapping -- so repeated presses cycle through the
# sessions' windows, and the first press is never wasted on where you are.
$target = $null
if ($candidates.Count -gt 0) {
  $front = [Fg]::GetForegroundWindow()
  # Which tab is showing only matters when the window in front is one of ours,
  # and asking costs a walk of the automation tree -- so ask at most once.
  $frontTab = $null
  $here = -1
  for ($i = 0; $i -lt $candidates.Count; $i++) {
    if ($candidates[$i].Window.Handle -ne $front) { continue }
    if ($null -eq $frontTab) { $frontTab = Get-SelectedTab $front }
    # Being in the window is only being *here* if it is also showing this tab.
    if ((-not $candidates[$i].Tab) -or ($candidates[$i].Tab.Name -eq $frontTab)) {
      $here = $i
      break
    }
  }

  # Presses move within the most urgent tier there is, and never out of it.
  #
  # Candidates are ranked with whoever needs you first, so the top tier is the
  # sessions that need you -- and while any session does, no press should spend
  # itself on one that does not. Stepping to $here + 1 through the whole ring,
  # which is what this did when a candidate was a whole window, does not
  # survive tabs: every session in a tabbed terminal is a candidate, so you are
  # nearly always sitting in the ring, and every second press would walk off
  # the blocked session onto something merely busy.
  #
  # Within the tier a press still moves on, so two sessions waiting on you are
  # both a press away. A tier of one means a press re-raises the one session
  # that needs you, which is the honest answer to "take me to who needs me".
  $tier = $candidates[0].Urgency
  $ring = @($candidates | Where-Object { $_.Urgency -eq $tier })

  $target = $ring[0]
  if ($here -ge 0) {
    $hereWindow = $candidates[$here].Window.Handle
    $hereTab = if ($candidates[$here].Tab) { $candidates[$here].Tab.Name } else { '' }
    for ($i = 0; $i -lt $ring.Count; $i++) {
      $ringTab = if ($ring[$i].Tab) { $ring[$i].Tab.Name } else { '' }
      if (($ring[$i].Window.Handle -eq $hereWindow) -and ($ringTab -eq $hereTab)) {
        $target = $ring[($i + 1) % $ring.Count]
        break
      }
    }
  }
}

# Still nothing: a process-only target (the "any VS Code window" last resort).
# The terminal equivalent needs no twin here -- a wanted terminal window
# already joined the ring above.
if (-not $target) {
  foreach ($t in $Targets) {
    if ($t.Title -or (-not $t.Process)) { continue }
    $window = $windows | Where-Object { $_.Process -like $t.Process } | Select-Object -First 1
    if ($window) {
      $target = [pscustomobject]@{ Window = $window; Tab = $null }
      break
    }
  }
}
if (-not $target) {
  Write-Output 'none'
  exit 1
}

$window = $target.Window

# Bring the tab to the front of its window before the window comes to the front
# of the desktop, so the session is already showing when the window arrives
# rather than flicking over a moment later. Selecting works on a background
# window, and a refusal costs only the tab: the window is still worth raising.
$tabName = ''
if ($target.Tab) {
  try {
    $selection = $null
    if ($target.Tab.Element.TryGetCurrentPattern(
          [System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) {
      $selection.Select()
      $tabName = $target.Tab.Name
    }
  } catch {
    # The tab went away between being found and being chosen.
  }
}

# Windows refuses SetForegroundWindow to a process that is not already in front,
# so restore first, then bribe it with a brief topmost flip if the call fails.
[void][Fg]::AllowSetForegroundWindow($window.Pid)
if ([Fg]::IsIconic($window.Handle)) { [void][Fg]::ShowWindow($window.Handle, $SW_RESTORE) }

if (-not [Fg]::SetForegroundWindow($window.Handle)) {
  [void][Fg]::SetWindowPos($window.Handle, $TOPMOST, 0, 0, 0, 0, $NOMOVE_NOSIZE_NOACTIVATE)
  [void][Fg]::SetWindowPos($window.Handle, $NOTOPMOST, 0, 0, 0, 0, $NOMOVE_NOSIZE_NOACTIVATE)
  [void][Fg]::SetForegroundWindow($window.Handle)
}

# Name the tab when there was one: "raised: <window>" and "raised: <tab>" are
# different enough outcomes that the log should not have to guess which it was.
$what = if ($tabName) { $tabName } else { $window.Title }

if ([Fg]::GetForegroundWindow() -eq $window.Handle) {
  Write-Output ("raised: " + $what)
  exit 0
}
Write-Output ("failed: " + $what)
exit 2
