<#
.SYNOPSIS
  Builds dist\aspycharm-<version>.vsix from source. Only needed after a code change.

.DESCRIPTION
  Uses a portable Node in .tools\ (downloaded once, SHA-256 checked against nodejs.org). Nothing is
  installed system-wide. Dependencies come from yarn.lock only, with package install scripts disabled.

.PARAMETER Test
  Also run the extension's test suite. The first run downloads a test copy of VS Code into .vscode-test\.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\build.ps1 -Test
#>
param([switch]$Test)
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$nodeVersion = 'v20.18.1'
$yarnVersion = '1.22.22'
$vsceVersion = '3.2.1'
$tools = Join-Path $root '.tools'
$nodeDir = Join-Path $tools "node-$nodeVersion-win-x64"

function Invoke-Checked {
  param([string]$Exe, [string[]]$Arguments)
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Exe $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

# 1. Portable Node
if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) {
  New-Item -ItemType Directory -Force $tools | Out-Null
  $name = "node-$nodeVersion-win-x64.zip"
  $zip = Join-Path $tools $name
  $base = "https://nodejs.org/dist/$nodeVersion"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Write-Host "Downloading Node $nodeVersion ..."
  Invoke-WebRequest "$base/$name" -OutFile $zip -UseBasicParsing
  $sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content
  if ($sums -is [byte[]]) { $sums = [Text.Encoding]::ASCII.GetString($sums) }
  $line = ($sums -split "`n") | Where-Object { $_ -match " $([regex]::Escape($name))\s*$" } | Select-Object -First 1
  if (-not $line) { throw "No checksum for $name in SHASUMS256.txt" }
  $want = ($line -split '\s+')[0].ToLower()
  $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($want -ne $got) { Remove-Item $zip; throw "Node checksum mismatch: expected $want, got $got" }
  Write-Host "Node checksum OK"
  Expand-Archive $zip -DestinationPath $tools -Force
  Remove-Item $zip
}
$env:PATH = "$nodeDir;$env:PATH"
if (-not (Test-Path (Join-Path $nodeDir 'yarn.cmd'))) {
  Invoke-Checked 'npm.cmd' @('install', '-g', '--ignore-scripts', "yarn@$yarnVersion")
}

Push-Location $root
try {
  # 2. Dependencies (lockfile only, no install scripts) and compile
  Invoke-Checked 'yarn.cmd' @('install', '--frozen-lockfile', '--ignore-scripts', '--non-interactive')
  Invoke-Checked 'yarn.cmd' @('run', 'compile')

  # 3. Tests (optional)
  if ($Test) {
    # Set when this runs from a VS Code terminal; it would make the test copy of VS Code start as plain Node.
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Invoke-Checked 'node.exe' @('./out/test/runTest.js')
  }

  # 4. Package
  $version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
  $dist = Join-Path $root 'dist'
  New-Item -ItemType Directory -Force $dist | Out-Null
  Get-ChildItem $dist -Filter '*.vsix' | Remove-Item
  $out = Join-Path $dist "aspycharm-$version.vsix"
  # README's relative links resolve against our Forgejo (vsce only auto-detects GitHub / GitLab).
  $repo = 'http://192.168.3.241:3000/catalinpop/VSCodeAsPycharm'
  Invoke-Checked 'npx.cmd' @('--yes', "@vscode/vsce@$vsceVersion", 'package', '--yarn', '-o', $out,
    '--baseContentUrl', "$repo/src/branch/main", '--baseImagesUrl', "$repo/raw/branch/main")
  Write-Host "Built $out"
} finally {
  Pop-Location
}
