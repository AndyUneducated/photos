#!/bin/bash
# Double-click this on a Mac to open the photo studio. It installs whatever is missing on first run.
# If macOS refuses to open it, run it once from Terminal instead:  bash start.command
cd "$(dirname "$0")" || exit 1
if ! /bin/bash scripts/bootstrap.sh; then
  echo
  echo "Startup failed. The error message above explains why."
  read -r -n 1 -p "Press any key to close this window..."
  echo
fi
