<#
  Windows auto-start for Relay (Task Scheduler, current user, no admin needed).
  Starts at logon, runs hidden, and restarts if it stops.

  Usually run for you by `npm run autostart`. By hand, from the repo folder:
    powershell -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1
  Remove:
    powershell -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1 -Uninstall
  Logs: data\service.log
#>
param(
  [string]$RelayDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$NodePath = $(try { (Get-Command node -ErrorAction Stop).Source } catch { '' }),
  [string]$TaskName = 'WhatsApp Relay',
  [switch]$Uninstall,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

if ($Uninstall) {
  if ($DryRun) { "Would remove scheduled task '$TaskName'"; exit 0 }
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  "Removed '$TaskName'."
  exit 0
}

if (-not $NodePath -or -not (Test-Path $NodePath)) { throw 'Node.js was not found. Install Node.js 22.13+ or pass -NodePath.' }
$service = Join-Path $RelayDir 'scripts\relay-service.mjs'
if (-not (Test-Path $service)) { throw "Not a Relay folder: $RelayDir" }
$log = Join-Path $RelayDir 'data\service.log'

# A hidden PowerShell host keeps Node's console window out of sight.
$command = "& '$($NodePath -replace "'", "''")' '$($service -replace "'", "''")' --log '$($log -replace "'", "''")'"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$command`"" -WorkingDirectory $RelayDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

if ($DryRun) {
  "Task:      $TaskName"
  "Runs:      powershell.exe -WindowStyle Hidden -Command $command"
  "Trigger:   at logon of $env:USERNAME"
  exit 0
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Relay: WhatsApp bridge for AI clients' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
"Installed and started '$TaskName'. It will start automatically at logon. Logs: $log"
