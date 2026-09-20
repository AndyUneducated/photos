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
        throw "$label 没有安装，而这台机器上也没有 winget。请手动安装 $label 后重新运行。"
    }
    Write-Step "正在安装 $label（首次运行需要几分钟）"
    winget install --id $id --exact --accept-source-agreements --accept-package-agreements --disable-interactivity
    Update-PathFromRegistry
}

# ---------------------------------------------------------------- prerequisites

Write-Step '检查运行环境'

if (-not (Test-Command 'node')) {
    Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js'
}
if (-not (Test-Command 'node')) {
    throw 'Node.js 安装后仍然找不到，请关掉这个窗口重新双击 start.cmd（新窗口才会有更新后的 PATH）。'
}

$nodeMajor = (& node -e 'process.stdout.write(process.versions.node.split(".")[0])')
if ([int]$nodeMajor -lt 20) {
    throw "需要 Node.js 20 或更高版本，当前是 v$nodeMajor。请升级 Node.js 后重试。"
}
Write-Ok "Node.js $(& node -v)"

if (-not (Test-Command 'git')) {
    Install-WithWinget 'Git.Git' 'Git'
}
if (-not (Test-Command 'git')) {
    throw 'Git 安装后仍然找不到，请关掉这个窗口重新双击 start.cmd。'
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
        Write-Step '安装依赖（首次运行大约 1-2 分钟）'
        if (Test-Path (Join-Path $root 'package-lock.json')) { npm ci } else { npm install }
        if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' }
    }
    else {
        Write-Ok '依赖已是最新'
    }

    # ------------------------------------------------------------ gallery branch

    if (-not (Test-Path (Join-Path $root '.git'))) {
        Write-Step '初始化 git 仓库'
        git init -b main | Out-Null
    }

    Write-Step '检查 gallery 分支'
    node scripts/setup-gallery.mjs
    if ($LASTEXITCODE -ne 0) { throw 'gallery 分支初始化失败。' }

    # ------------------------------------------------------------ run

    Write-Step '启动相册工作台'
    node studio/server.mjs
}
finally {
    Pop-Location
}
