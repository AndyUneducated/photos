<#
  Brings a machine from "nothing installed" to "studio running in the browser".

  Designed to be safe to run repeatedly: every step checks whether it is needed first. The point
  is that moving to a new PC should mean copying this folder and double-clicking start.cmd, with
  no manual Node or git installation.
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

$nodeMajor = (& node -e 'process.stdout.write(process.versions.node.split(".")[0])')
if ([int]$nodeMajor -lt 20) {
    throw "Node.js 20 or newer is required, but this machine has v$nodeMajor. Please upgrade Node.js and try again."
}
Write-Ok "Node.js $(& node -v)"

if (-not (Test-Command 'git')) {
    Install-WithWinget 'Git.Git' 'Git'
}
if (-not (Test-Command 'git')) {
    throw 'Git still cannot be found after installing it. Close this window and double-click start.cmd again.'
}
Write-Ok (& git --version)

# ---------------------------------------------------------------- dependencies

Push-Location $root
try {
    $needInstall = $false
    if (-not (Test-Path (Join-Path $root 'node_modules'))) {
        $needInstall = $true
    }
    else {
        # Reinstall when the lockfile is newer than the installed tree, which is what happens after
        # a git pull that changed dependencies.
        $lock = Join-Path $root 'package-lock.json'
        $stamp = Join-Path $root 'node_modules\.package-lock.json'
        if ((Test-Path $lock) -and (Test-Path $stamp)) {
            if ((Get-Item $lock).LastWriteTimeUtc -gt (Get-Item $stamp).LastWriteTimeUtc) {
                $needInstall = $true
            }
        }
    }

    if ($needInstall) {
        Write-Step 'Installing dependencies (about 1-2 minutes on the first run)'
        if (Test-Path (Join-Path $root 'package-lock.json')) { npm ci } else { npm install }
        if ($LASTEXITCODE -ne 0) { throw 'Installing dependencies failed.' }
    }
    else {
        Write-Ok 'Dependencies are already up to date'
    }

    # ------------------------------------------------------------ gallery branch

    if (-not (Test-Path (Join-Path $root '.git'))) {
        Write-Step 'Initializing the git repository'
        git init -b main | Out-Null
    }

    Write-Step 'Checking the gallery branch'
    node scripts/setup-gallery.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Setting up the gallery branch failed.' }

    # ------------------------------------------------------------ run

    Write-Step 'Starting the photo studio'
    node studio/server.mjs
}
finally {
    Pop-Location
}
