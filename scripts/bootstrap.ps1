<#
  Brings a Windows machine from "nothing installed" to "studio running in the browser".

  Designed to be safe to run repeatedly: every step checks whether it is needed first. The point
  is that moving to a new PC should mean copying this folder (or cloning it) and double-clicking
  start.cmd, with no manual Node or git installation.

  This file only installs Node and git. Everything after that (dependencies, the repository, the
  gallery branch) is scripts/prepare.mjs, which the macOS launcher shares.
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Write-Step($text) { Write-Host "`n>> $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "   $text" -ForegroundColor DarkGray }

# winget installs modify the machine/user PATH, but not the PATH of the already-running shell.
function Update-PathFromRegistry {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = @($machine, $user | Where-Object { $_ }) -join ';'
}

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Install-WithWinget($id, $label) {
    if (-not (Test-Command 'winget')) {
        throw "$label is not installed, and this machine does not have winget either. Please install $label by hand and run this again."
    }
    Write-Step "Installing $label (a few minutes, only on the first run)"
    winget install --id $id --exact --accept-source-agreements --accept-package-agreements --disable-interactivity
    Update-PathFromRegistry
}

# ---------------------------------------------------------------- prerequisites

Write-Step 'Checking the environment'

if (-not (Test-Command 'node')) {
    Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js'
}
if (-not (Test-Command 'node')) {
    throw 'Node.js still cannot be found after installing it. Close this window and double-click start.cmd again (only a new window picks up the updated PATH).'
}

$nodeOld = (& node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.stdout.write(String(a < 20 || (a === 20 && b < 11)))')
if ($nodeOld -eq 'true') {
    Write-Step "Upgrading Node.js (this machine has $(& node -v); 20.11 or newer is needed)"
    if (Test-Command 'winget') {
        winget upgrade --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements --disable-interactivity
        Update-PathFromRegistry
    }
    else {
        throw "Node.js 20.11 or newer is required, but this machine has $(& node -v). Please upgrade Node.js and try again."
    }
}
Write-Ok "Node.js $(& node -v)"

if (-not (Test-Command 'git')) {
    Install-WithWinget 'Git.Git' 'Git'
}
if (-not (Test-Command 'git')) {
    throw 'Git still cannot be found after installing it. Close this window and double-click start.cmd again.'
}
Write-Ok (& git --version)

# ---------------------------------------------------------------- everything else

Push-Location $root
try {
    node scripts/prepare.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Setup did not finish; the message above explains why.' }

    # ------------------------------------------------------------ run

    Write-Step 'Starting the photo studio'
    node studio/server.mjs
}
finally {
    Pop-Location
}
