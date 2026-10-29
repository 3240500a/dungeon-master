# Запуск сервера (:3001) с поз-редактором (:5173) и редактора конфигов (:5174), открытие вкладок в браузере. Играют Unity.
. (Join-Path $PSScriptRoot '_common.ps1')

$Root = Get-RepoRoot
Write-Host ''
Write-Host '  Dungeon Master — запуск' -ForegroundColor Green
Write-Host "  Каталог: $Root"
Write-Host ''

Assert-Npm
Install-IfNeeded $Root

# Сервер и поз-редактор (concurrently). ⭐ С3 (29.10): веб-клиента больше нет в запуске — играют Unity.
if (Test-Port 5173) {
    Write-Host '  Поз-редактор уже запущен на :5173 — новое окно не открываю.' -ForegroundColor Yellow
} else {
    Write-Host '  Запускаю сервер + поз-редактор (npm run dev)...' -ForegroundColor Cyan
    Start-DevWindow $Root 'dev' 'DM: server + pose editor'
}

# Редактор.
if (Test-Port 5174) {
    Write-Host '  Редактор уже запущен на :5174.' -ForegroundColor Yellow
} else {
    Write-Host '  Запускаю редактор конфигов (npm run editor)...' -ForegroundColor Cyan
    Start-DevWindow $Root 'editor' 'DM: editor'
}

Write-Host ''
Write-Host '  Ожидаю готовности серверов...' -ForegroundColor Cyan

if (Wait-Port 5173 120) {
    Start-Process 'http://localhost:5173/pose-editor.html'
    Write-Host '  Поз-редактор открыт: http://localhost:5173/pose-editor.html' -ForegroundColor Green
} else {
    Write-Host '  Поз-редактор не поднялся за отведённое время (см. окно с логами).' -ForegroundColor Red
}

if (Wait-Port 5174 60) {
    Start-Process 'http://localhost:5174'
    Write-Host '  Редактор открыт: http://localhost:5174' -ForegroundColor Green
} else {
    Write-Host '  Редактор не поднялся за отведённое время (см. окно с логами).' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '  Готово. Серверы работают в отдельных окнах — закройте их, чтобы остановить.' -ForegroundColor Green
Start-Sleep -Seconds 2
