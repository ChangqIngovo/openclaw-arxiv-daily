# Run in a normal PowerShell terminal. No execution-policy bypass is applied.
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Install Node.js 24.16+ from https://nodejs.org/en/download, reopen PowerShell and rerun.'
}
$ArxivState = if ($env:OPENCLAW_STATE_DIR) { $env:OPENCLAW_STATE_DIR } else { Join-Path $env:USERPROFILE '.openclaw' }
$ArxivInstallerDir = Join-Path $ArxivState 'arxiv-daily-installer'
New-Item -ItemType Directory -Force -Path $ArxivInstallerDir | Out-Null
$ArxivDownload = Join-Path $ArxivInstallerDir ('download-' + [Guid]::NewGuid().ToString('N') + '.cjs')
try {
  Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/ChangqIngovo/openclaw-arxiv-daily/main/install-arxiv-daily.cjs' -OutFile $ArxivDownload -ErrorAction Stop
  $ArxivInstaller = Join-Path $ArxivInstallerDir 'install-arxiv-daily.cjs'
  Move-Item -LiteralPath $ArxivDownload -Destination $ArxivInstaller -Force
  & node $ArxivInstaller @args
  if ($LASTEXITCODE -ne 0) { throw 'Setup did not finish. Read the preceding output.' }
} finally {
  if (Test-Path -LiteralPath $ArxivDownload) { Remove-Item -LiteralPath $ArxivDownload -Force }
}
