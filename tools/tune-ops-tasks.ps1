#Requires -Version 5.1
<#
    tune-ops-tasks.ps1 —— 把两个运维计划任务改成高频（2026-10-22，主人 m03035）

    背景：13:54 那次掉线只持续 2.5 分钟，watchdog 10 分钟一查整段错过，
          既没生成快照也没发通知。验收要求「掉线 ≤2 分钟发现并自动恢复」。

    改动：
      Molly-Watchdog   repetition PT10M -> PT1M   （夜间由脚本内部降频到 5 分钟）
      Molly-Heartbeat  repetition PT3M  -> PT1M   （夜间由脚本内部降到 3 分钟）

    做法：只改触发器的 repetition，其余（动作/主体/设置）保持原样；改完回读验证。
    必须提权运行（任务主体是最高权限）。
#>
param(
    [switch]$SkipHeartbeat,
    [switch]$SkipWatchdog
)

$ErrorActionPreference = 'Stop'
$ROOT = '${MOLLY_ROOT}\qq-whale'
$LOG = Join-Path $ROOT 'out\tune-ops-tasks.log'
$RESULT = Join-Path $ROOT 'out\tune-ops-tasks.json'

function Write-Step {
    param([string]$Name, [string]$Text)
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Name, $Text
    Write-Host $line
    Add-Content -Path $LOG -Value $line -Encoding UTF8
}

function Set-Repetition {
    param(
        [Parameter(Mandatory = $true)][string]$TaskName,
        [Parameter(Mandatory = $true)][int]$Minutes
    )
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $old = @($task.Triggers)[0]
    if (-not $old) { throw "$TaskName 没有触发器，无法改频率" }
    $oldInterval = if ($old.Repetition) { $old.Repetition.Interval } else { '' }

    $interval = 'PT{0}M' -f $Minutes

    # 先试原地改（部分系统上 CIM 对象可写）；失败或回读不对就重建触发器。
    $ok = $false
    try {
        if (-not $old.Repetition) { throw '触发器没有 Repetition 属性' }
        $old.Repetition.Interval = $interval
        # 原任务若是「一次 + 无限重复」，Duration 一般是 P3650D/PD；保留原值即可
        Set-ScheduledTask -TaskName $TaskName -Trigger $old | Out-Null
        $ok = $true
    } catch {
        Write-Step 'rebuild' ("{0} 原地改失败（{1}），改为重建触发器" -f $TaskName, $_.Exception.Message)
    }

    if (-not $ok) {
        $startAt = Get-Date
        try { $startAt = [datetime]$old.StartBoundary } catch { }
        if ($startAt -lt (Get-Date)) {
            # 保持「从现在起算的第一个整点前」的模式：从当前时间起算
            $startAt = Get-Date
        }
        $newTrigger = New-ScheduledTaskTrigger -Once -At $startAt `
            -RepetitionInterval (New-TimeSpan -Minutes $Minutes) `
            -RepetitionDuration (New-TimeSpan -Days 3650)
        Set-ScheduledTask -TaskName $TaskName -Trigger $newTrigger | Out-Null
    }

    $check = Get-ScheduledTask -TaskName $TaskName
    $got = @($check.Triggers)[0]
    $newInterval = if ($got.Repetition) { $got.Repetition.Interval } else { '' }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Step 'ok' ("{0}: repetition {1} -> {2}，state={3}，next={4}" -f `
        $TaskName, $oldInterval, $newInterval, $check.State, $info.NextRunTime)
    if ($newInterval -ne $interval) {
        throw "$TaskName 回读频率不对：期望 $interval，实际 $newInterval"
    }
    return [pscustomobject]@{
        task = $TaskName
        oldInterval = $oldInterval
        newInterval = $newInterval
        state = [string]$check.State
        nextRun = [string]$info.NextRunTime
    }
}

try {
    Write-Step 'start' ("admin={0} user={1}" -f `
        ([bool]([System.Security.Principal.WindowsPrincipal][System.Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)), `
        [System.Security.Principal.WindowsIdentity]::GetCurrent().Name)

    $rows = @()
    if (-not $SkipWatchdog) { $rows += Set-Repetition -TaskName 'Molly-Watchdog' -Minutes 1 }
    if (-not $SkipHeartbeat) { $rows += Set-Repetition -TaskName 'Molly-Heartbeat' -Minutes 1 }

    # 顺手确认 SnowLuma 的三个提权任务还在（迁移后可回滚的依据）
    $others = @()
    foreach ($t in 'SnowLuma-Boot', 'SnowLuma-Relogin', 'SnowLuma-Stop', 'Molly-Console') {
        $x = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
        if ($x) {
            $i = Get-ScheduledTaskInfo -TaskName $t
            $others += [pscustomobject]@{ task = $t; state = [string]$x.State; lastRun = [string]$i.LastRunTime; lastResult = $i.LastTaskResult }
        } else {
            $others += [pscustomobject]@{ task = $t; state = 'MISSING'; lastRun = ''; lastResult = $null }
        }
    }

    $out = [ordered]@{
        at = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        ok = $true
        rows = $rows
        others = $others
    }
    Write-Step 'done' 'RESULT OK'
} catch {
    $out = [ordered]@{
        at = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        ok = $false
        error = $_.Exception.Message
        rows = @()
    }
    Write-Step 'error' $_.Exception.Message
}

$out | ConvertTo-Json -Depth 6 | Set-Content -Path $RESULT -Encoding UTF8
Write-Host ''
Write-Host ("结果已写入：{0}" -f $RESULT)
