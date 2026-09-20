param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$helper = Join-Path $projectRoot 'resources\replace-save.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ("peppered-replace-smoke-" + [Guid]::NewGuid().ToString('N'))

function Write-Bytes([string]$Path, [string]$Value) {
  [IO.File]::WriteAllBytes($Path, [Text.Encoding]::UTF8.GetBytes($Value))
}

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Invoke-GuardedReplace(
  [string]$Target,
  [string]$Replacement,
  [string]$ExpectedTarget,
  [string]$ExpectedReplacement,
  [bool]$ExpectSuccess
) {
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper `
    -TargetPath $Target `
    -TemporaryPath $Replacement `
    -ExpectedTargetSha256 $ExpectedTarget `
    -ExpectedReplacementSha256 $ExpectedReplacement
  $exitCode = $LASTEXITCODE
  if ($ExpectSuccess -and $exitCode -ne 0) { throw "Guarded replace failed with exit code $exitCode" }
  if (-not $ExpectSuccess -and $exitCode -eq 0) { throw 'Guarded replace unexpectedly succeeded' }
}

try {
  New-Item -ItemType Directory -Path $root | Out-Null

  $target = Join-Path $root 'Save.es3'
  $replacement = Join-Path $root 'existing.tmp'
  Write-Bytes $target 'old-save-bytes'
  Write-Bytes $replacement 'new-save-bytes'
  Invoke-GuardedReplace $target $replacement (Get-Sha256 $target) (Get-Sha256 $replacement) $true
  if ([Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($target)) -ne 'new-save-bytes') { throw 'Existing-target bytes were not replaced' }
  if (Test-Path -LiteralPath $replacement) { throw 'Existing-target replacement path still exists' }

  $absent = Join-Path $root 'Absent\Save.es3'
  New-Item -ItemType Directory -Path (Split-Path -Parent $absent) | Out-Null
  $absentReplacement = Join-Path (Split-Path -Parent $absent) 'absent.tmp'
  Write-Bytes $absentReplacement 'absent-target-bytes'
  Invoke-GuardedReplace $absent $absentReplacement 'ABSENT' (Get-Sha256 $absentReplacement) $true
  if ([Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($absent)) -ne 'absent-target-bytes') { throw 'Absent target was not created' }

  $changed = Join-Path $root 'Changed.es3'
  $changedReplacement = Join-Path $root 'changed.tmp'
  Write-Bytes $changed 'current-bytes'
  Write-Bytes $changedReplacement 'replacement-bytes'
  Invoke-GuardedReplace $changed $changedReplacement ('0' * 64) (Get-Sha256 $changedReplacement) $false
  if ([Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($changed)) -ne 'current-bytes') { throw 'Changed target was overwritten' }
  if (-not (Test-Path -LiteralPath $changedReplacement)) { throw 'Rejected replacement was not preserved' }

  $busy = Join-Path $root 'Busy.es3'
  $busyReplacement = Join-Path $root 'busy.tmp'
  Write-Bytes $busy 'busy-current'
  Write-Bytes $busyReplacement 'busy-replacement'
  $heldWriter = [IO.File]::Open($busy, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
  try {
    Invoke-GuardedReplace $busy $busyReplacement (Get-Sha256 $busy) (Get-Sha256 $busyReplacement) $false
  } finally {
    $heldWriter.Dispose()
  }
  if ([Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($busy)) -ne 'busy-current') { throw 'Busy target was overwritten' }

  Write-Output 'WINDOWS_REPLACE_SMOKE_PASS existing=true absent=true changed=true busy=true'
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
