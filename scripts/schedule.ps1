<#
  수집기를 작업 스케줄러에 등록한다.

  기본값: 업무시간(08~20시) 동안 15분마다.
  - 요청량은 1회당 3~5건으로, 사람이 포털을 한 번 여는 것(약 29건)보다 훨씬 적다.
  - RandomDelay 를 두어 매번 정확히 같은 초에 몰리지 않게 한다.
  - 계정 1개를 공유하므로 수집기는 이 PC 한 대에서만 돌려야 한다.
    (동시 실행은 코드의 락이 막지만, 여러 PC 에 등록하면 세션이 서로 밀린다)

  사용:
    powershell -ExecutionPolicy Bypass -File scripts\schedule.ps1
    powershell -ExecutionPolicy Bypass -File scripts\schedule.ps1 -IntervalMinutes 30
    powershell -ExecutionPolicy Bypass -File scripts\schedule.ps1 -Remove
#>
param(
  [int]$IntervalMinutes = 15,
  [int]$StartHour = 8,
  [int]$EndHour = 20,
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
$taskName = "BroadcomSrHub-Collect"
$root = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $root "scripts\collect.cmd"

if ($Remove) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "제거됨: $taskName"
  } else {
    Write-Output "등록된 작업이 없습니다: $taskName"
  }
  exit 0
}

if (-not (Test-Path $runner)) { throw "실행 파일을 찾을 수 없습니다: $runner" }

$durationHours = $EndHour - $StartHour
if ($durationHours -le 0) { throw "EndHour 는 StartHour 보다 커야 합니다." }

$action = New-ScheduledTaskAction -Execute $runner -WorkingDirectory $root

# RandomDelay 는 트리거 속성이다. 매 실행이 정확히 같은 초에 몰리지 않게 한다.
$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.AddHours($StartHour)) `
  -RandomDelay (New-TimeSpan -Minutes 2)
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At ([datetime]::Today.AddHours($StartHour)) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Hours $durationHours)).Repetition

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
  -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Settings $settings -Description "Broadcom SR Hub 케이스 수집" | Out-Null

Write-Output "등록 완료: $taskName"
Write-Output ("  주기   : {0}분마다, {1}시 ~ {2}시" -f $IntervalMinutes, $StartHour, $EndHour)
Write-Output ("  실행   : {0}" -f $runner)
Write-Output ("  로그   : {0}" -f (Join-Path $root "data\collect.log"))
Write-Output ""
Write-Output "지금 한 번 돌려보려면:  Start-ScheduledTask -TaskName $taskName"
Write-Output "제거하려면          :  powershell -ExecutionPolicy Bypass -File scripts\schedule.ps1 -Remove"
