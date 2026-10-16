param([string]$Executable = (Join-Path $PSScriptRoot '../src-tauri/target/release/codex-web.exe'))
$ErrorActionPreference = 'Stop'
$Executable = (Resolve-Path $Executable).Path
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../Temp/token-speed-qa/backend-fixture'))
$sessionDir = Join-Path $root 'sessions/2026/10/16'
New-Item -ItemType Directory -Force $sessionDir | Out-Null
$file = Join-Path $sessionDir 'rollout-fixture.jsonl'
$utf8 = [Text.UTF8Encoding]::new($false)
function Record($kind, $payload) {
    return (@{timestamp=[DateTime]::UtcNow.ToString('o'); type=$kind; payload=$payload} | ConvertTo-Json -Compress -Depth 12) + "`n"
}
function ResponseRecords([int]$n, [int]$output, [int]$cumulativeOutput) {
    $end = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $usage = @{input_tokens=1000; output_tokens=$output; reasoning_output_tokens=20; total_tokens=1000+$output}
    $cumulative = @{input_tokens=1000*$n; output_tokens=$cumulativeOutput; total_tokens=1000*$n+$cumulativeOutput}
    $text = Record 'event_msg' @{type='item_completed';turn_id='fixture-turn';item=@{type='AgentMessage';id="item-$n"};started_at_ms=$end-2000;completed_at_ms=$end}
    $text += Record 'token_usage_record' @{turn_id='fixture-turn';response_id="response-$n";usage=$usage;thread_token_usage=$cumulative}
    $text += Record 'event_msg' @{type='token_count';info=@{last_token_usage=$usage;total_token_usage=$cumulative}}
    return $text
}
$text = Record 'session_meta' @{id='fixture-session';cwd='C:/fixtures/BackendTest';source='cli'}
$text += Record 'event_msg' @{type='task_started';turn_id='fixture-turn'}
$text += Record 'turn_context' @{model='gpt-test-backend'}
$text += ResponseRecords 1 84 84
[IO.File]::WriteAllText($file,$text,$utf8)

# Bind only loopback on a currently free port. Child receives only the synthetic Codex home.
$probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$probe.Start(); $port=$probe.LocalEndpoint.Port; $probe.Stop()
$psi = [Diagnostics.ProcessStartInfo]::new($Executable)
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.Environment['CODEX_HOME'] = $root
$psi.Environment['CODEX_SWITCHER_WEB_HOST'] = '127.0.0.1'
$psi.Environment['CODEX_SWITCHER_WEB_PORT'] = "$port"
$process = [Diagnostics.Process]::Start($psi)
try {
    $base = "http://127.0.0.1:$port"
    $ready=$false
    for($i=0;$i -lt 40;$i++) {
        if($process.HasExited){throw 'Fixture backend exited before becoming ready'}
        try { $health=Invoke-RestMethod "$base/api/health" -TimeoutSec 1; if($health.ok){$ready=$true;break} } catch { Start-Sleep -Milliseconds 100 }
    }
    if(-not $ready){throw 'Fixture backend did not become ready'}
    function Snapshot { Invoke-RestMethod "$base/api/invoke/get_token_speed_snapshot" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 10 }
    $first=Snapshot
    if($first.sessions.Count -ne 1 -or $first.sessions[0].model -ne 'gpt-test-backend'){throw 'Incorrect session/model'}
    if($first.sessions[0].latest.tokens_per_second -ne 42 -or $first.sessions[0].sample_count -ne 1){throw 'Incorrect initial rate or duplicate carrier handling'}
    [IO.File]::AppendAllText($file,(ResponseRecords 2 126 210),$utf8)
    $second=Snapshot
    if($second.sessions[0].latest.tokens_per_second -ne 63 -or $second.sessions[0].sample_count -ne 2){throw 'Incremental update failed'}
    if($second.sessions[0].recent_average_tps -ne 52.5){throw 'Incorrect weighted average'}
    $third=Snapshot
    if($third.sessions[0].sample_count -ne 2){throw 'Unchanged file generated duplicate samples'}
    $report=@{status='pass';initial_tps=42;appended_tps=63;weighted_average_tps=52.5;sample_count=2;isolated_home=$true;auth_requests=0}
    [IO.File]::WriteAllText((Join-Path $root '../backend-report.json'),($report | ConvertTo-Json),$utf8)
    'TOKEN_SPEED_BACKEND_PASSED: real HTTP command, isolated home, initial read, incremental append, cross-carrier dedup and weighted average.'
} finally {
    if(-not $process.HasExited){$process.Kill();$process.WaitForExit()}
    $process.Dispose()
}
