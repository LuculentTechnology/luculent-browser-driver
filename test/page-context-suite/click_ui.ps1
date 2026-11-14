param(
  [Parameter(Mandatory=$true)][string]$Name,
  [string]$TitleSubstr = ""
)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
if (-not ("UiaInput" -as [type])) {
  Add-Type -TypeDefinition (Get-Content -Raw -Path (Join-Path $PSScriptRoot "UiaInput.cs"))
}
[void][UiaInput]::SetProcessDpiAwareness(2)
$root = [System.Windows.Automation.AutomationElement]::RootElement
$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$chrome = $null
foreach ($w in $wins) {
  $n = $w.Current.Name
  if ($n -and ($n -like "*Google Chrome*" -or $n -like "*Chrome")) {
    if (-not $chrome) { $chrome = $w }
    if ($TitleSubstr -and $n -like ("*" + $TitleSubstr + "*")) { $chrome = $w }
  }
}
if (-not $chrome) { Write-Output "no_chrome_window"; exit 2 }
$hwnd = [IntPtr]$chrome.Current.NativeWindowHandle
[void][UiaInput]::ShowWindow($hwnd, 9)
[void][UiaInput]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 250
$found = $null
$all = $chrome.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($el in $all) {
  try { $n = $el.Current.Name } catch { continue }
  if ($n -and $n -like ("*" + $Name + "*")) {
    $found = $el
    Write-Output ("found=" + ($n -replace "[\r\n]+"," | "))
    break
  }
}
if (-not $found) {
  $all2 = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($el in $all2) {
    try { $n = $el.Current.Name } catch { continue }
    if ($n -and $n -like ("*" + $Name + "*")) {
      $found = $el
      Write-Output ("found_desktop=" + ($n -replace "[\r\n]+"," | "))
      break
    }
  }
}
if (-not $found) { Write-Output "not_found"; exit 3 }
$wr = New-Object RECT
[void][UiaInput]::GetWindowRect($hwnd, [ref]$wr)
$br = $chrome.Current.BoundingRectangle
$mon = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$ww = [double]($wr.Right - $wr.Left); if ($ww -le 0) { $ww = 1 }
$wh = [double]($wr.Bottom - $wr.Top); if ($wh -le 0) { $wh = 1 }
# UIA/GetWindowRect may be in 150% px while SetCursorPos and WinForms are physical.
$sx = 1.0; $sy = 1.0
if ($ww -gt $mon.Width * 1.05) { $sx = $ww / [double]$mon.Width }
elseif ($br.Width -gt $mon.Width * 1.05) { $sx = $br.Width / [double]$mon.Width }
if ($wh -gt $mon.Height * 1.05) { $sy = $wh / [double]$mon.Height }
elseif ($br.Height -gt $mon.Height * 1.05) { $sy = $br.Height / [double]$mon.Height }
Write-Output ("scale=" + $sx + "," + $sy + " win=" + $wr.Left + "," + $wr.Top + "," + $wr.Right + "," + $wr.Bottom + " mon=" + $mon.Width + "x" + $mon.Height)
$invoked = $false
try {
  $pat = $found.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $pat.Invoke()
  $invoked = $true
  Write-Output "invoked=1"
} catch { }
if (-not $invoked) {
  $pt = $found.GetClickablePoint()
  $x = [int]($pt.X / $sx)
  $y = [int]($pt.Y / $sy)
  Write-Output ("point=" + $x + "," + $y + " uia=" + [int]$pt.X + "," + [int]$pt.Y)
  $clicker = Join-Path $PSScriptRoot "dpi_click.py"
  $py = (Get-Command python -ErrorAction SilentlyContinue).Source
  if (-not $py) { $py = "python" }
  $out = & $py $clicker ([int]$pt.X) ([int]$pt.Y) 2>&1
  Write-Output ("clicked=1 " + $out)
}
exit 0
