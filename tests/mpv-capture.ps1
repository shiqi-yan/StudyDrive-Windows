param(
  [Parameter(Mandatory)][long]$WindowHandle,
  [Parameter(Mandatory)][int]$Left,
  [Parameter(Mandatory)][int]$Top,
  [Parameter(Mandatory)][int]$Right,
  [Parameter(Mandatory)][int]$Bottom,
  [Parameter(Mandatory)][string]$Output
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MxNative {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
  [DllImport("user32")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32")] public static extern IntPtr GetAncestor(IntPtr window, uint kind);
  [DllImport("user32")] public static extern bool GetClientRect(IntPtr window, out Rect bounds);
  [DllImport("user32")] public static extern bool ClientToScreen(IntPtr window, ref Point origin);
}
'@
$null = [MxNative]::SetProcessDpiAwarenessContext([IntPtr](-4))
$window = [IntPtr]$WindowHandle
if ([MxNative]::GetAncestor([MxNative]::GetForegroundWindow(), 2) -ne $window) {
  throw 'The isolated StudyDrive proof window is not in the foreground'
}
Add-Type -AssemblyName System.Drawing,System.Windows.Forms
$r = New-Object MxNative+Rect
$origin = New-Object MxNative+Point
if (![MxNative]::GetClientRect($window, [ref]$r) -or ![MxNative]::ClientToScreen($window, [ref]$origin)) {
  throw 'Isolated window no longer exists'
}
$desktop = [Windows.Forms.SystemInformation]::VirtualScreen
$area = [Drawing.Rectangle]::Intersect($desktop, (New-Object Drawing.Rectangle($origin.X,$origin.Y,$r.R,$r.B)))
$video = [Drawing.Rectangle]::Intersect($area, [Drawing.Rectangle]::FromLTRB($Left,$Top,$Right,$Bottom))
if ($video.Width -lt 160 -or $video.Height -lt 90) { throw 'No visible embedded video region' }
$image = New-Object Drawing.Bitmap($area.Width,$area.Height)
try {
  $graphics = [Drawing.Graphics]::FromImage($image)
  try { $graphics.CopyFromScreen($area.Location, [Drawing.Point]::Empty, $area.Size) }
  finally { $graphics.Dispose() }
  $color = 0
  for($i=1; $i -lt 10; $i++) {
    for($j=1; $j -lt 8; $j++) {
      $pixel = $image.GetPixel(([int]($video.X-$area.X+$video.Width*$i/10)),([int]($video.Y-$area.Y+$video.Height*$j/8)))
      $values = @([int]$pixel.R,[int]$pixel.G,[int]$pixel.B) | Sort-Object
      if ($values[2] - $values[0] -gt 35) { $color++ }
    }
  }
  if ($color -lt 7) { throw "Expected colored decoded pixels inside native video region, sampled=$color" }
  $image.Save($Output, [Drawing.Imaging.ImageFormat]::Png)
  [pscustomobject]@{ coloredPoints = $color; videoWidth = $video.Width; videoHeight = $video.Height } | ConvertTo-Json -Compress
} finally { $image.Dispose() }
