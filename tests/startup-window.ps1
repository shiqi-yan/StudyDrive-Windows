param([Parameter(Mandatory)][string]$Control)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StudyDriveWindow {
    private delegate bool WindowCallback(IntPtr window, IntPtr state);
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(WindowCallback callback, IntPtr state);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr window);
    public static bool HasVisibleWindow(uint pid) {
        bool visible = false;
        EnumWindows((window, state) => {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner == pid && IsWindowVisible(window)) { visible = true; return false; }
            return true;
        }, IntPtr.Zero);
        return visible;
    }
}
'@
Write-Output 'READY'
for ($i=0;$i -lt 600 -and !(Test-Path -LiteralPath $Control);$i++) { Start-Sleep -Milliseconds 30 }
$target=Get-Content -LiteralPath $Control -Raw|ConvertFrom-Json
$processMs=$null
$windowMs=$null
$launcherWindowMs=$null
for ($i=0;$i -lt 3600;$i++) {
    if (!$target.direct -and $null -eq $launcherWindowMs) {
        if([StudyDriveWindow]::HasVisibleWindow($target.pid)) {
            $launcherWindowMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $target.start
        }
    }
    $ids=if($target.direct){@($target.pid)} else {
        @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($target.pid) AND Name='StudyDrive.exe'" | Select-Object -ExpandProperty ProcessId)
    }
    $candidates=if($ids.Count){Get-Process -Id $ids -ErrorAction SilentlyContinue}
    if ($candidates -and $null -eq $processMs) {
        $processMs=([DateTimeOffset]($candidates|Select-Object -First 1).StartTime).ToUnixTimeMilliseconds() - $target.start
    }
    foreach($process in $candidates) {
        if($process.MainWindowHandle -and $process.MainWindowTitle -match ('^' + [string][char]0x8BFE + [char]0x76D8 + '( \d+\.\d+\.\d+)?$') -and [StudyDriveWindow]::IsWindowVisible($process.MainWindowHandle)) {
            $windowMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $target.start
            [pscustomobject]@{electronMs=$processMs; visibleMs=$windowMs; launcherVisibleMs=$launcherWindowMs; pid=$process.Id; exe=$process.Path} | ConvertTo-Json -Compress
            exit 0
        }
    }
    Start-Sleep -Milliseconds 35
}
[pscustomobject]@{electronMs=$processMs;visibleMs=$windowMs}|ConvertTo-Json -Compress
exit 1
