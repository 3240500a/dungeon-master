# Подготовка ВТОРОЙ МАШИНЫ под сервер нагрузочного стенда.
#
# Это не боевой деплой (тот — docs/DEPLOY.md, Linux + Caddy + HTTPS). Здесь машина в локальной
# сети поднимает сервер, а грузить его будут с ноутбука. Смысл затеи: на одной машине прибор
# и сервер делят процессор, а все задержки идут через петлю, где сети попросту нет. Значит
# ни ёмкость, ни хвосты задержки, ни поведение при переполнении исходящей очереди на одной
# машине не проверяются.
#
#   powershell -ExecutionPolicy Bypass -File tools\deploy\setup-stand.ps1
#
# Скрипт НИЧЕГО не ставит молча: чего нет — про то он скажет и даст точную команду. Ставить
# Node и Postgres за спиной у человека на его личной машине — плохая идея.

param(
  # Пароль роли `dm`. Машина в локальной сети, наружу порты не смотрят — пароль здесь
  # не секрет, а совпадение с тем, что ждёт код.
  [string]$DbPassword = 'dmpass',
  # Пароль суперпользователя postgres. Пусто — psql спросит сам (нужен только на первом запуске).
  [string]$PostgresPassword = '',
  # Сколько игровых портов открыть в фаерволе: гейтвей + ноды. 14 хватает на 9950X с запасом.
  [int]$Ports = 14,
  [int]$BasePort = 3001,
  [switch]$SkipFirewall
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root
$ok = $true

function Say([string]$state, [string]$text) {
  $color = 'Gray'
  if ($state -eq 'ok')   { $color = 'Green' }
  if ($state -eq 'нет')  { $color = 'Red' }
  if ($state -eq 'надо') { $color = 'Yellow' }
  Write-Host ("  [{0,-4}] {1}" -f $state, $text) -ForegroundColor $color
}

Write-Host "`n=== Проверка окружения ===" -ForegroundColor Cyan

# --- Node 24 ---
$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
  Say 'нет' 'Node не найден. Поставить: winget install OpenJS.NodeJS.LTS  (нужна версия 24)'
  $ok = $false
} else {
  $v = (node -v).TrimStart('v').Split('.')[0]
  if ([int]$v -lt 24) {
    Say 'нет' "Node $((node -v)) — нужен 24 (в .nvmrc). winget install OpenJS.NodeJS.LTS"
    $ok = $false
  } else {
    Say 'ok' "Node $(node -v)"
  }
}

# --- Postgres ---
$svc = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1
$psql = Get-Command psql -ErrorAction SilentlyContinue
if ($null -eq $psql) {
  # Установщик кладёт psql в Program Files, но в PATH не добавляет.
  $found = Get-ChildItem 'C:\Program Files\PostgreSQL' -Filter psql.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $found) {
    $env:PATH = "$($found.DirectoryName);$env:PATH"
    $psql = Get-Command psql -ErrorAction SilentlyContinue
  }
}
if ($null -eq $svc) {
  Say 'нет' 'PostgreSQL не найден. Поставить: winget install PostgreSQL.PostgreSQL.17'
  Say ' '   '  При установке запомнить пароль пользователя postgres — он понадобится ниже.'
  $ok = $false
} elseif ($svc.Status -ne 'Running') {
  Say 'надо' "Служба $($svc.Name) остановлена. Запустить: Start-Service $($svc.Name)"
  $ok = $false
} else {
  Say 'ok' "PostgreSQL: служба $($svc.Name) работает"
}

# --- git (нужен npm для uWebSockets.js — он ставится прямо из GitHub) ---
if ($null -eq (Get-Command git -ErrorAction SilentlyContinue)) {
  Say 'нет' 'git не найден, а без него npm не поставит uWebSockets.js (пакет ставится из GitHub). winget install Git.Git'
  $ok = $false
} else {
  Say 'ok' "git $(git --version)"
}

if (-not $ok) {
  Write-Host "`nСначала поставь недостающее, потом запусти скрипт снова.`n" -ForegroundColor Yellow
  exit 1
}

# --- База: роль dm и две базы ---
Write-Host "`n=== База ===" -ForegroundColor Cyan
# Сперва пробуем зайти уже готовой ролью. Если получилось — делать нечего, и пароль
# суперпользователя спрашивать незачем: повторный запуск скрипта не должен ничего требовать.
$dmWorks = $false
if ($null -ne $psql) {
  $env:PGPASSWORD = $DbPassword
  & psql "postgresql://dm@127.0.0.1:5432/dungeon_test" -tAc 'select 1' 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { $dmWorks = $true }
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}

if ($dmWorks) {
  Say 'ok' 'роль dm и база dungeon_test уже на месте'
} elseif ($null -eq $psql) {
  Say 'надо' 'psql не в PATH — базы создай вручную, SQL ниже'
  $ok = $false
} else {
  if ($PostgresPassword -ne '') {
    $env:PGPASSWORD = $PostgresPassword
  } else {
    Write-Host '  Сейчас psql спросит пароль пользователя postgres (тот, что задавали при установке).'
    Write-Host '  Чтобы не спрашивал — перезапусти с ключом -PostgresPassword <пароль>.'
  }
  # Роль и базы создаются как есть: dungeon для игры, dungeon_test под стенд. Отдельная база
  # под стенд обязательна — боты плодят аккаунты сотнями, боевые данные этим засорять нельзя.
  $sql = @"
DO `$`$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dm') THEN
    CREATE ROLE dm LOGIN PASSWORD '$DbPassword';
  ELSE
    ALTER ROLE dm PASSWORD '$DbPassword';
  END IF;
END `$`$;
SELECT 'CREATE DATABASE dungeon OWNER dm' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname='dungeon')\gexec
SELECT 'CREATE DATABASE dungeon_test OWNER dm' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname='dungeon_test')\gexec
"@
  $tmp = Join-Path $env:TEMP 'dm-db-setup.sql'
  Set-Content -Path $tmp -Value $sql -Encoding utf8
  & psql -U postgres -h 127.0.0.1 -v ON_ERROR_STOP=1 -f $tmp
  if ($LASTEXITCODE -eq 0) { Say 'ok' 'роль dm и базы dungeon / dungeon_test готовы' }
  else { Say 'нет' 'psql вернул ошибку — создай базы вручную (SQL в этом файле)' ; $ok = $false }
  Remove-Item $tmp -ErrorAction SilentlyContinue
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
}

# --- Зависимости ---
Write-Host "`n=== Зависимости ===" -ForegroundColor Cyan
if (Test-Path 'node_modules') {
  Say 'ok' 'node_modules на месте (переустановить: npm ci)'
} else {
  Write-Host '  npm ci — это несколько минут…'
  npm ci
  if ($LASTEXITCODE -ne 0) { Say 'нет' 'npm ci упал'; exit 1 }
  Say 'ok' 'зависимости поставлены'
}
if (Test-Path 'node_modules\uWebSockets.js') {
  Say 'ok' 'uWebSockets.js на месте — транспорт по умолчанию'
} else {
  Say 'надо' 'uWebSockets.js не поставился (нужен git). Сервер поднимется на `ws`, но замеры будут не те: DM_WS=ws'
}

# --- Фаервол ---
Write-Host "`n=== Фаервол ===" -ForegroundColor Cyan
if ($SkipFirewall) {
  Say 'надо' 'пропущено по ключу -SkipFirewall'
} else {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) {
    Say 'надо' 'нет прав администратора — запусти PowerShell от имени администратора, иначе ноутбук не достучится'
  } else {
    # Один порт под одиночный сервер (3999) и диапазон под кластер: гейтвей + ноды.
    $range = "3999,$BasePort-$($BasePort + $Ports)"
    $name = 'dungeon-master стенд'
    Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP `
      -LocalPort $range.Split(',') -Profile Private,Domain | Out-Null
    Say 'ok' "открыты TCP $range (профили Private и Domain)"
  }
}

# --- Итог ---
$ips = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }).IPAddress
Write-Host "`n=== Готово ===" -ForegroundColor Cyan
Write-Host "  Адреса этой машины: $($ips -join ', ')"
Write-Host "  Запуск сервера:  powershell -ExecutionPolicy Bypass -File tools\deploy\run-stand.ps1 -Mode single"
Write-Host "                   powershell -ExecutionPolicy Bypass -File tools\deploy\run-stand.ps1 -Mode cluster -Nodes 12"
Write-Host "  С ноутбука:      dmload --base=http://<адрес>:3999 --mode=net`n"
