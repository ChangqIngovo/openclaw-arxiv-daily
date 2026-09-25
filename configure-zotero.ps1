# Compatibility entry point. Personal Zotero setup is now implemented in Node on both platforms.
$ErrorActionPreference = 'Stop'
$ArxivInstaller = Join-Path $env:USERPROFILE 'install-arxiv-daily.cjs'
if (-not (Test-Path -LiteralPath $ArxivInstaller)) {
  throw 'Run your downloaded install-arxiv-daily.cjs with --configure-zotero instead.'
}
& node $ArxivInstaller --configure-zotero
if ($LASTEXITCODE -ne 0) { throw 'Zotero setup did not finish. Read the preceding output.' }
