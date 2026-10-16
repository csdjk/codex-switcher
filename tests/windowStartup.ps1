# Native Windows smoke test: verifies real windows, not just a living process.
# Run with Windows PowerShell. Does not switch accounts, stop Codex, or read credentials.
param(
    [string]$Executable = (Join-Path $PSScriptRoot '../Temp/token-speed-preview/codex-switcher.exe')
)
$ErrorActionPreference = 'Stop'
$Executable = (Resolve-Path $Executable).Path
if ((Split-Path $Executable -Leaf) -ne 'codex-switcher.exe') { throw 'Expected a Codex Switcher executable' }
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class SwitcherWindowTest {
    public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr param);
    public static bool HasBrowserRenderer(IntPtr main) {
        bool ready = false;
        EnumChildWindows(main, (h, param) => {
            var name = new StringBuilder(256); GetClassName(h, name, name.Capacity);
            if (name.ToString() == "Chrome_RenderWidgetHostHWND") { ready = true; return false; }
            return true;
        }, IntPtr.Zero);
        return ready;
    }
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder b, int size);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    struct Rect { public int Left, Top, Right, Bottom; }
    public static IntPtr FindMain(int pid) {
        IntPtr result = IntPtr.Zero; long largest = 0;
        EnumWindows((h, param) => {
            uint owner; GetWindowThreadProcessId(h, out owner);
            if (owner != pid) return true;
            var name = new StringBuilder(256); GetClassName(h, name, name.Capacity);
            if (name.ToString() != "Tauri Window") return true;
            Rect r; GetWindowRect(h, out r);
            long area = (long)(r.Right-r.Left)*(r.Bottom-r.Top);
            // Reject the 16x16 event target and small tray popups.
            if (r.Right-r.Left >= 550 && r.Bottom-r.Top >= 400 && area > largest) {
                largest = area; result = h;
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
'@
function Assert-True([bool]$Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Get-Instances {
    @(Get-Process -Name codex-switcher -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Executable })
}
$instances = @(Get-Instances)
Assert-True ($instances.Count -le 1) 'Multiple existing preview processes: resolve the startup blocker first'
if ($instances.Count -eq 0) {
    $first = Start-Process -FilePath $Executable -WorkingDirectory (Split-Path $Executable) -PassThru
} else { $first = $instances[0] }
$h = [IntPtr]::Zero
for ($attempt=0; $attempt -lt 100; $attempt++) {
    $first.Refresh()
    Assert-True (-not $first.HasExited) 'First instance exited before creating its main window'
    $h = [SwitcherWindowTest]::FindMain($first.Id)
    if ($h -ne [IntPtr]::Zero -and [SwitcherWindowTest]::HasBrowserRenderer($h)) { break }
    Start-Sleep -Milliseconds 150
}
Assert-True ($h -ne [IntPtr]::Zero) 'Process started, but no real main window was created'
Assert-True ([SwitcherWindowTest]::HasBrowserRenderer($h)) 'Main window exists, but WebView2 has not initialized'
# The native HWND is created before WebView2. Do not manipulate that provisional
# window while the controller is still being created in a nested message loop.
Start-Sleep -Milliseconds 500
$results = @()
function Assert-DuplicateRestores([string]$Name) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $duplicate = Start-Process -FilePath $Executable -WorkingDirectory $env:TEMP -PassThru
    Assert-True ($duplicate.WaitForExit(15000)) 'Second instance remained running instead of handing off'
    $timer.Stop()
    Assert-True ($duplicate.ExitCode -eq 0) 'Second instance did not exit successfully'
    for ($i=0; $i -lt 30; $i++) {
        if ([SwitcherWindowTest]::IsWindowVisible($h) -and -not [SwitcherWindowTest]::IsIconic($h)) { break }
        Start-Sleep -Milliseconds 100
    }
    Assert-True ([SwitcherWindowTest]::IsWindowVisible($h)) "$Name left the main window hidden"
    Assert-True (-not [SwitcherWindowTest]::IsIconic($h)) "$Name left the main window minimized"
    $after = @(Get-Instances)
    Assert-True ($after.Count -eq 1 -and $after[0].Id -eq $first.Id) "$Name created or replaced the first instance"
    [PSCustomObject]@{case=$Name;status='pass';handoff_ms=$timer.ElapsedMilliseconds;foreground=([SwitcherWindowTest]::GetForegroundWindow() -eq $h)}
}
$results += Assert-DuplicateRestores 'repeat_open'
[void][SwitcherWindowTest]::ShowWindow($h,6)
Start-Sleep -Milliseconds 250
Assert-True ([SwitcherWindowTest]::IsIconic($h)) 'Could not arrange minimized-window test'
$results += Assert-DuplicateRestores 'minimize_then_reopen'
[void][SwitcherWindowTest]::PostMessage($h,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)
for ($i=0; $i -lt 30; $i++) {
    if (-not [SwitcherWindowTest]::IsWindowVisible($h)) { break }
    Start-Sleep -Milliseconds 100
}
Assert-True (-not [SwitcherWindowTest]::IsWindowVisible($h)) 'Close did not hide the window to the tray'
$results += Assert-DuplicateRestores 'close_to_tray_then_reopen'
$output = Join-Path $PSScriptRoot '../Temp/startup-qa/window-startup-report.json'
New-Item -ItemType Directory -Force (Split-Path $output) | Out-Null
$report = @{status='pass';pid=$first.Id;main_window=$h.ToInt64();executable=$Executable;cases=$results;left_running=$true;verified_at=[DateTime]::UtcNow.ToString('o')}
$report | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $output
$report | ConvertTo-Json -Depth 6
Write-Output 'WINDOW_STARTUP_PASSED: real main window, repeated launch, minimized restore, close-to-tray restore, one process retained.'
