[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$reaRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$desktopSource = Join-Path $reaRoot 'source\desktop'
$electronExe = Join-Path $reaRoot 'tools\desktop-runtime\node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronExe -PathType Leaf)) {
    throw 'The app-local Electron runtime is missing. See the REA development guide; no software was installed.'
}
$reaTemp = Join-Path $reaRoot 'work\tmp'
New-Item -ItemType Directory -Path $reaTemp -Force | Out-Null
$env:TEMP = $reaTemp
$env:TMP = $reaTemp
# This is the requested interactive GUI. A hidden startup flag also hides its first window.
Start-Process -FilePath $electronExe -ArgumentList ('"' + $desktopSource + '"') -WorkingDirectory $desktopSource -WindowStyle Normal
