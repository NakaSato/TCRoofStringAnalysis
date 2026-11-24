# IP Switcher helper: remove the per-user install. Keeps audit.log unless -All is given.
param([switch]$All)
$ErrorActionPreference = 'Stop'
$HostName = 'com.tcroof.ipswitcher'
$Target = Join-Path $env:LOCALAPPDATA 'IPSwitcher'

if (Test-Path (Join-Path $Target 'pending.json')) {
    Write-Warning 'A network change is still waiting for Keep / Revert. Finish it in the extension first.'
    exit 1
}
foreach ($browser in @('Software\Google\Chrome', 'Software\Microsoft\Edge')) {
    Remove-Item -Force -ErrorAction SilentlyContinue -Path "HKCU:\$browser\NativeMessagingHosts\$HostName"
}
foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
    Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $folder 'IP Switcher.lnk')
}
Remove-ItemProperty -ErrorAction SilentlyContinue -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce' -Name 'IPSwitcherRevert'
if ($All) {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Target
} else {
    Get-ChildItem -ErrorAction SilentlyContinue $Target | Where-Object { $_.Name -notlike 'audit.log*' } | Remove-Item -Force
}
Write-Host 'IP Switcher helper removed.'
