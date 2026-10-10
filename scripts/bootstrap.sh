#!/bin/bash
#
# Brings a Mac (or Linux machine) from "nothing installed" to "studio running in the browser".
# The counterpart of bootstrap.ps1: it only makes sure Node and git exist, installing them with
# Homebrew on a Mac when they are missing, then hands over to scripts/prepare.mjs.
#
# Safe to run repeatedly; every step checks whether it is needed first.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

step() { printf '\n\033[36m>> %s\033[0m\n' "$1"; }
ok()   { printf '   \033[90m%s\033[0m\n' "$1"; }
die()  { printf '\n\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

# A double-clicked .command runs a non-login, non-interactive shell, which never reads the user's
# shell profile. Put the usual install locations on PATH ourselves so an existing Homebrew or nvm
# Node is found instead of being installed a second time.
for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin"; do
  if [ -d "$dir" ]; then
    case ":$PATH:" in *":$dir:"*) ;; *) PATH="$dir:$PATH" ;; esac
  fi
done
export PATH
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  set +u; . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true; set -u
fi

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 11) ? 0 : 1)'
}

# On a Mac /usr/bin/git always exists, but it is a stub that only works once the Command Line
# Tools are installed, so "is it on the PATH" is not enough.
git_ok() {
  git --version >/dev/null 2>&1
}

ensure_brew() {
  command -v brew >/dev/null 2>&1 && return
  [ "$(uname -s)" = "Darwin" ] || die "Node.js 20.11+ and git are required. Install them with your package manager, then run this again."
  step 'Installing Homebrew (only on the first run; it may ask for your Mac password)'
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  for brew in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$brew" ]; then eval "$("$brew" shellenv)"; fi
  done
  command -v brew >/dev/null 2>&1 || die "Homebrew was installed but cannot be found. Close this window and double-click start.command again."
}

step 'Checking the environment'

if ! node_ok; then
  ensure_brew
  if command -v node >/dev/null 2>&1 && brew list node >/dev/null 2>&1; then
    step "Upgrading Node.js ($(node -v) is too old; 20.11 or newer is needed)"
    brew upgrade node
  elif command -v node >/dev/null 2>&1; then
    die "Node.js 20.11 or newer is required, but $(node -v) is installed outside Homebrew ($(command -v node)). Upgrade it, then run this again."
  else
    step 'Installing Node.js (a few minutes, only on the first run)'
    brew install node
  fi
  hash -r
  node_ok || die "Node.js still cannot be found after installing it. Close this window and double-click start.command again."
fi
ok "Node.js $(node -v)"

if ! git_ok; then
  ensure_brew
  step 'Installing git (only on the first run)'
  brew install git
  hash -r
  git_ok || die "git still does not work. Run \"xcode-select --install\", then double-click start.command again."
fi
ok "$(git --version)"

node scripts/prepare.mjs || die "Setup did not finish; the message above explains why."

step 'Starting the photo studio'
exec node studio/server.mjs
