<#
.SYNOPSIS
  Installs AsPycharm into VS Code on this machine from the prebuilt dist\vscodeaspycharm-*.vsix (no Node needed).

.DESCRIPTION
  - Finds VS Code's command line (code.cmd) on PATH or in the usual install folders.
  - Uninstalls the five extensions AsPycharm replaces, if present: moshfeu.compare-folders,
    linda-cheung.content-menu-item-refresh, tumuerzunong.pycharm-like-snippets, yingbo.charmrun and
    rufat.py-doc-links. Their commands, views, snippets, Alt+P and docstring links would clash with AsPycharm's.
  - Installs the VSIX (--force, so re-running it updates or reinstalls).

.PARAMETER Vsix
  A specific .vsix to install. Default: the one in dist\.

.PARAMETER Pull
  Run "git pull --ff-only" in this checkout first, to install the latest version from Forgejo.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Pull   # from the cloned folder
#>
param([string]$Vsix, [switch]$Pull)
$ErrorActionPreference = 'Stop'

$replaced = @('moshfeu.compare-folders', 'linda-cheung.content-menu-item-refresh', 'tumuerzunong.pycharm-like-snippets',
  'yingbo.charmrun', 'rufat.py-doc-links')
$id = 'catalinpop.aspycharm'

if ($Pull) {
  git -C $PSScriptRoot pull --ff-only
  if ($LASTEXITCODE -ne 0) { throw 'git pull failed' }
}

if (-not $Vsix) {
  $found = @(Get-ChildItem (Join-Path $PSScriptRoot 'dist') -Filter 'vscodeaspycharm-*.vsix' -ErrorAction SilentlyContinue)
  if ($found.Count -ne 1) { throw "Expected exactly one dist\vscodeaspycharm-*.vsix, found $($found.Count). Run build.ps1 first." }
  $Vsix = $found[0].FullName
}
if (-not (Test-Path $Vsix)) { throw "Not found: $Vsix" }

$code = $null
$cmd = Get-Command 'code.cmd' -ErrorAction SilentlyContinue
if ($cmd) { $code = $cmd.Source }
if (-not $code) {
  foreach ($p in @("$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd",
                   "$env:ProgramFiles\Microsoft VS Code\bin\code.cmd")) {
    if (Test-Path $p) { $code = $p; break }
  }
}
if (-not $code) { throw 'VS Code command line (code.cmd) not found. Install VS Code first.' }

# Runs code.cmd and drops its stderr (Node deprecation warnings). Windows PowerShell 5.1 would turn that stderr
# into a terminating error under $ErrorActionPreference = 'Stop', so it is relaxed for the call only.
function Invoke-Code {
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $code @args 2>$null } finally { $ErrorActionPreference = $saved }
}

$installed = @(Invoke-Code --list-extensions)
foreach ($old in $replaced) {
  if ($installed -contains $old) {
    Write-Host "Uninstalling $old (replaced by AsPycharm)"
    Invoke-Code --uninstall-extension $old
    if ($LASTEXITCODE -ne 0) { throw "Failed to uninstall $old" }
  }
}

Write-Host "Installing $Vsix"
Invoke-Code --install-extension $Vsix --force
if ($LASTEXITCODE -ne 0) { throw 'VS Code refused the VSIX' }

$now = @(Invoke-Code --list-extensions --show-versions) | Where-Object { $_ -like "$id@*" }
if (-not $now) { throw "$id is not listed after install" }
Write-Host "Installed $now. Reload open VS Code windows (Ctrl+Shift+P > Developer: Reload Window)."
