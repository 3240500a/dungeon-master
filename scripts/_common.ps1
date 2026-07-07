# Общие хелперы для лаунчеров (dot-source из start-*.ps1).
# Только PowerShell, без python/node-прослоек. Node/npm нужны самому проекту (Vite/Express).

$ErrorActionPreference = 'Stop'

function Get-RepoRoot {
    # scripts/ лежит в корне репозитория.
    return (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

function Assert-Npm {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Host ''
        Write-Host '  Не найден npm (Node.js).' -ForegroundColor Red
        Write-Host '  Это Node/Vite-проект — установите Node.js LTS с https://nodejs.org и повторите.' -ForegroundColor Yellow
        Write-Host ''
        Read-Host '  Нажмите Enter для выхода'
        exit 1
    }
}

function Install-IfNeeded([string]$Root) {
    if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
        Write-Host '  Первый запуск: устанавливаю зависимости (npm install)...' -ForegroundColor Cyan
        Push-Location $Root
        try {
            & cmd /c 'npm install'
            if ($LASTEXITCODE -ne 0) {
                Write-Host '  npm install завершился с ошибкой.' -ForegroundColor Red
                Read-Host '  Нажмите Enter для выхода'
                exit 1
            }
        } finally {
            Pop-Location
        }
    }
}

function Test-Port([int]$Port) {
    # Быстрая одиночная проверка: слушает ли кто-то порт.
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        $ok = $async.AsyncWaitHandle.WaitOne(300)
        if ($ok) { $client.EndConnect($async) }
        $client.Close()
        return $ok
    } catch {
        return $false
    }
}

function Wait-Port([int]$Port, [int]$TimeoutSec = 90) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        if (Test-Port $Port) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Start-DevWindow([string]$Root, [string]$NpmScript, [string]$Title) {
    # Отдельное видимое окно cmd с логами; закрытие окна останавливает серверы.
    Start-Process -FilePath 'cmd.exe' `
        -ArgumentList '/k', "title $Title && npm run $NpmScript" `
        -WorkingDirectory $Root | Out-Null
}
