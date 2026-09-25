param(
  [string]$ClientKey,
  [string]$CallbackUrl = 'https://changqingovo.github.io/openclaw-arxiv-daily/zotero-callback.html'
)
$ErrorActionPreference = 'Stop'
$ArxivTemporary = $null
$ArxivPatch = $null
$ArxivSecretPointer = [IntPtr]::Zero
try {
  $ArxivInspect = (& openclaw plugins inspect arxiv-daily --json | Out-String)
  if ($LASTEXITCODE -ne 0) { throw 'Install or upgrade arxiv-daily first.' }
  $ArxivStart = $ArxivInspect.IndexOf('{')
  $ArxivEnd = $ArxivInspect.LastIndexOf('}')
  if ($ArxivStart -lt 0 -or $ArxivEnd -le $ArxivStart) { throw 'Cannot read the registered plugin path.' }
  $ArxivPlugin = $ArxivInspect.Substring($ArxivStart, $ArxivEnd - $ArxivStart + 1) | ConvertFrom-Json
  $ArxivRoot = $ArxivPlugin.plugin.rootDir
  $ArxivPackage = Get-Content -Raw -LiteralPath (Join-Path $ArxivRoot 'package.json') | ConvertFrom-Json
  if ($ArxivPackage.name -ne 'openclaw-arxiv-daily' -or $ArxivPackage.version -ne '0.4.0') { throw 'This configurator requires arxiv-daily 0.4.0.' }
  $ArxivCallback = [Uri]$CallbackUrl
  if (-not $ArxivCallback.IsAbsoluteUri -or $ArxivCallback.Scheme -ne 'https' -or $ArxivCallback.UserInfo -or $ArxivCallback.Query -or $ArxivCallback.Fragment) { throw 'Use the public HTTPS callback page URL without a query or fragment.' }
  if (-not $ClientKey) { $ClientKey = Read-Host 'Zotero OAuth Client Key' }
  if ($ClientKey -notmatch '^[A-Za-z0-9_-]{8,256}$') { throw 'Invalid Client Key.' }
  $ArxivState = if ($env:OPENCLAW_STATE_DIR) { $env:OPENCLAW_STATE_DIR } else { Join-Path $env:USERPROFILE '.openclaw' }
  $ArxivFolder = Join-Path $ArxivState 'arxiv-daily'
  New-Item -ItemType Directory -Force -Path $ArxivFolder | Out-Null
  $ArxivCredentials = Join-Path $ArxivFolder 'zotero-app.json'
  if (Test-Path -LiteralPath $ArxivCredentials) {
    $ArxivExisting = Get-Content -Raw -LiteralPath $ArxivCredentials | ConvertFrom-Json
    $ArxivMaster = $ArxivExisting.encryptionKey
    if (-not $ArxivMaster -or [Convert]::FromBase64String($ArxivMaster).Length -ne 32) { throw 'Existing encryption key is invalid. Restore the original credentials file; do not reset it.' }
  } else {
    $ArxivDatabase = Join-Path $ArxivFolder 'state.sqlite'
    if (Test-Path -LiteralPath $ArxivDatabase) {
      $ArxivCheck = Join-Path $ArxivRoot 'src\zotero-setup-check.js'
      & node $ArxivCheck $ArxivDatabase
      if ($LASTEXITCODE -ne 0) { throw 'Zotero credentials already exist in the database. Restore the matching zotero-app.json before continuing.' }
    }
    $ArxivRandom = New-Object byte[] 32
    $ArxivRng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $ArxivRng.GetBytes($ArxivRandom) } finally { $ArxivRng.Dispose() }
    $ArxivMaster = [Convert]::ToBase64String($ArxivRandom)
  }
  $ArxivSecureSecret = Read-Host 'Zotero OAuth Client Secret (hidden)' -AsSecureString
  $ArxivSecretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ArxivSecureSecret)
  $ArxivSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ArxivSecretPointer)
  if ($ArxivSecret -notmatch '^[A-Za-z0-9._~-]{8,256}$') { throw 'Invalid Client Secret.' }
  $ArxivUtf8 = New-Object System.Text.UTF8Encoding($false)
  $ArxivPatch = Join-Path $env:TEMP ('arxiv-zotero-patch-' + [Guid]::NewGuid().ToString('N') + '.json')
  $ArxivUpdate = @{plugins=@{entries=@{'arxiv-daily'=@{config=@{zotero=@{enabled=$true;credentialsFile=$ArxivCredentials}}}}}} | ConvertTo-Json -Depth 10
  [IO.File]::WriteAllText($ArxivPatch, $ArxivUpdate, $ArxivUtf8)
  & openclaw config patch --file $ArxivPatch --dry-run
  if ($LASTEXITCODE -ne 0) { throw 'Config validation failed. Credentials were not replaced.' }
  $ArxivTemporary = $ArxivCredentials + '.tmp-' + [Guid]::NewGuid().ToString('N')
  New-Item -ItemType File -Path $ArxivTemporary | Out-Null
  $ArxivSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $ArxivTemporary /inheritance:r /grant:r "*$($ArxivSid):(F)" '*S-1-5-18:(F)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Cannot restrict the credentials file permissions.' }
  $ArxivSettings = @{clientKey=$ClientKey;clientSecret=$ArxivSecret;callbackUrl=$ArxivCallback.AbsoluteUri;encryptionKey=$ArxivMaster} | ConvertTo-Json
  [IO.File]::WriteAllText($ArxivTemporary, $ArxivSettings, $ArxivUtf8)
  Move-Item -LiteralPath $ArxivTemporary -Destination $ArxivCredentials -Force
  $ArxivTemporary = $null
  & openclaw config patch --file $ArxivPatch
  if ($LASTEXITCODE -ne 0) { throw 'Credentials saved, but config update failed. Resolve the error and rerun this configurator.' }
  Write-Host 'Zotero app configured. Restarting Gateway to load it.'
  & openclaw gateway restart
  if ($LASTEXITCODE -ne 0) { Write-Host 'Gateway restart did not confirm readiness. Check openclaw gateway status before retrying.' }
  Write-Host 'In each personal Weixin chat: /arxiv zotero connect'
} catch {
  Write-Error $_.Exception.Message
  exit 1
} finally {
  if ($ArxivSecretPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ArxivSecretPointer) }
  $ArxivSecret = $null
  $ArxivSettings = $null
  if ($ArxivTemporary -and (Test-Path -LiteralPath $ArxivTemporary)) { Remove-Item -LiteralPath $ArxivTemporary -Force }
  if ($ArxivPatch -and (Test-Path -LiteralPath $ArxivPatch)) { Remove-Item -LiteralPath $ArxivPatch -Force }
}
