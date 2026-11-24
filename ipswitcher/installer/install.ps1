# IP Switcher helper: per-user install (no admin needed). Spec §15.
# Copies ipswitch-host.exe to %LOCALAPPDATA%\IPSwitcher, writes the native messaging host manifest,
# and registers it for Chrome and Edge under HKCU.
#
#   install.cmd                                   (dev extension ID)
#   install.cmd -ExtensionId id1,id2              (e.g. the Chrome Web Store and Edge Add-ons IDs)
#   install.cmd -Browser edge                     (desktop shortcut opens Edge; default: Chrome if installed)
param(
    [string[]]$ExtensionId = @('gojmikegpclikdmngdgonghdcdemicib'),
    [ValidateSet('auto', 'chrome', 'edge')][string]$Browser = 'auto',
    [switch]$NoShortcut
)
$ErrorActionPreference = 'Stop'
$HostName = 'com.tcroof.ipswitcher'
$Source = Split-Path -Parent $MyInvocation.MyCommand.Path
$Target = Join-Path $env:LOCALAPPDATA 'IPSwitcher'
$Exe = Join-Path $Target 'ipswitch-host.exe'
$ManifestPath = Join-Path $Target 'host-manifest.json'

$ids = @($ExtensionId | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
foreach ($id in $ids) {
    if ($id -notmatch '^[a-p]{32}$') { throw "Not an extension ID: '$id' (32 letters a-p)" }
}

$srcExe = Join-Path $Source 'ipswitch-host.exe'
if (-not (Test-Path $srcExe)) { throw "ipswitch-host.exe not found next to install.ps1 ($Source)" }

New-Item -ItemType Directory -Force -Path $Target | Out-Null
if (Test-Path (Join-Path $Target 'pending.json')) {
    Write-Warning 'A network change is still waiting for Keep / Revert. Finish it in the extension, then run install again.'
    exit 1
}
Copy-Item -Force $srcExe $Exe
Unblock-File -Path $Exe -ErrorAction SilentlyContinue

$manifest = [ordered]@{
    name            = $HostName
    description     = 'IP Switcher helper: sets this PC''s IPv4 address for the IP Switcher extension'
    path            = $Exe
    type            = 'stdio'
    allowed_origins = @($ids | ForEach-Object { "chrome-extension://$_/" })
}
# UTF-8 without BOM (Chrome reads the file as JSON)
[System.IO.File]::WriteAllText($ManifestPath, ($manifest | ConvertTo-Json -Depth 3), (New-Object System.Text.UTF8Encoding $false))

foreach ($browser in @('Software\Google\Chrome', 'Software\Microsoft\Edge')) {
    $key = "HKCU:\$browser\NativeMessagingHosts\$HostName"
    New-Item -Force -Path $key | Out-Null
    Set-ItemProperty -Path $key -Name '(default)' -Value $ManifestPath
}

# Desktop + Start-menu shortcut "IP Switcher": opens the extension in its own app window
# (own taskbar button), like a desktop app. Chrome if installed, else Edge (-Browser to choose).
function Find-Browser([string]$exeName) {
    foreach ($root in @('HKCU:', 'HKLM:')) {
        $p = (Get-ItemProperty -ErrorAction SilentlyContinue "$root\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exeName").'(default)'
        if ($p -and (Test-Path $p)) { return $p }
    }
    return $null
}
$browserExe = $null
if ($Browser -ne 'edge') { $browserExe = Find-Browser 'chrome.exe' }
if (-not $browserExe -and $Browser -ne 'chrome') { $browserExe = Find-Browser 'msedge.exe' }
$Icon = Join-Path $Target 'ipswitcher.ico'
Copy-Item -Force (Join-Path $Source 'ipswitcher.ico') $Icon -ErrorAction SilentlyContinue
if ($browserExe -and -not $NoShortcut) {
    $shell = New-Object -ComObject WScript.Shell
    foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
        $lnk = $shell.CreateShortcut((Join-Path $folder 'IP Switcher.lnk'))
        $lnk.TargetPath = $browserExe
        $lnk.Arguments = "--app=chrome-extension://$($ids[0])/popup.html?mode=window --window-size=440,720"
        $lnk.WorkingDirectory = Split-Path -Parent $browserExe
        $lnk.IconLocation = "$Icon,0"
        $lnk.Description = 'Switch this PC''s IP address'
        $lnk.Save()
    }
    Write-Host "Shortcut 'IP Switcher' added to the desktop and Start menu ($([IO.Path]::GetFileName($browserExe)))."
} elseif (-not $browserExe) {
    Write-Warning 'Chrome / Edge not found: no desktop shortcut. Use the toolbar icon instead.'
}

$ver = & $Exe --version 2>$null
Write-Host "IP Switcher helper $ver installed to $Target"
Write-Host "Allowed extension IDs: $($ids -join ', ')"
Write-Host 'Restart Chrome / Edge if the extension still says the helper is missing.'
