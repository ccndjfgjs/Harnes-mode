# DeepSeek Harness - PowerShell старт
$env:DSH_HOME = 'C:\Users\Dedy_Sher\Desktop\deepseek-harness\dsh_home'
$env:WORKSPACE = 'C:\Users\Dedy_Sher\Desktop\deepseek-harness\workspace'
Write-Host '=== DeepSeek Harness ===' -ForegroundColor Cyan
Write-Host "DSH_HOME=$env:DSH_HOME"
Write-Host "WORKSPACE=$env:WORKSPACE"
if (-not $env:DEEPSEEK_API_KEY) {
    Write-Host '[ВНИМАНИЕ] DEEPSEEK_API_KEY не установлен!' -ForegroundColor Yellow
    Write-Host 'Получи ключ: https://platform.deepseek.com/api-keys'
    Write-Host 'Установи: $env:DEEPSEEK_API_KEY="sk-xxx"'
}
Write-Host ''
Write-Host '[1] Проверка dsh...' -ForegroundColor Green
try { & dsh --help 2>&1 | Select-Object -First 40 } catch { Write-Host "dsh не в PATH" }
Write-Host ''
Write-Host '[2] Запуск примера...' -ForegroundColor Green
python "$PSScriptRoot\example_run.py"
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Ошибка! Проверь ключ. Попробуй python simple_harness.py' -ForegroundColor Red
}
