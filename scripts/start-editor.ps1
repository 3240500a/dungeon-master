# Запуск только редактора конфигов (:5174) и открытие вкладки в браузере.
. (Join-Path $PSScriptRoot '_common.ps1')

$Root = Get-RepoRoot
Write-Host ''
Write-Host '  Dungeon Master — редактор конфигов' -ForegroundColor Green
Write-Host ''

Assert-Npm
Install-IfNeeded $Root

if (Test-Port 5174) {
    Write-Host '  Редактор уже запущен на :5174.' -ForegroundColor Yellow
} else {
    Write-Host '  Запускаю редактор (npm run editor)...' -ForegroundColor Cyan
    Start-DevWindow $Root 'editor' 'DM: editor'
}

if (Wait-Port 5174 90) {
    Start-Process 'http://localhost:5174'
    Write-Host '  Редактор открыт: http://localhost:5174' -ForegroundColor Green
} else {
    Write-Host '  Редактор не поднялся за отведённое время (см. окно с логами).' -ForegroundColor Red
}

Start-Sleep -Seconds 2
