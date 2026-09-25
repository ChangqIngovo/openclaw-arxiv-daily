#!/bin/sh
set -eu
if ! command -v node >/dev/null 2>&1; then
  echo 'Install Node.js 24.16+ from https://nodejs.org/en/download, reopen Terminal and rerun.' >&2
  exit 1
fi
ArxivInstallerDir="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/arxiv-daily-installer"
mkdir -p "$ArxivInstallerDir"
ArxivDownload=$(mktemp "$ArxivInstallerDir/download.XXXXXX")
trap 'rm -f "$ArxivDownload"' EXIT HUP INT TERM
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  https://raw.githubusercontent.com/ChangqIngovo/openclaw-arxiv-daily/main/install-arxiv-daily.cjs -o "$ArxivDownload"
mv "$ArxivDownload" "$ArxivInstallerDir/install-arxiv-daily.cjs"
node "$ArxivInstallerDir/install-arxiv-daily.cjs" "$@"
