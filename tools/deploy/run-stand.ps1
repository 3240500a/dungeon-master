# Запуск сервера под нагрузочный стенд на ВТОРОЙ МАШИНЕ.
#
#   -Mode single   — один процесс на :3999. С ним сравнимы все прежние замеры.
#   -Mode cluster  — гейтвей :3001 + N игровых нод :3002… Это то, ради чего 9950X и взяли.
#
#   powershell -ExecutionPolicy Bypass -File tools\deploy\run-stand.ps1 -Mode single
#   powershell -ExecutionPolicy Bypass -File tools\deploy\run-stand.ps1 -Mode cluster -Nodes 12
#
# ГЛАВНОЕ, ЧТО ЗДЕСЬ ДЕЛАЕТСЯ И БЕЗ ЧЕГО КЛАСТЕР НЕ РАБОТАЕТ ПО СЕТИ: `DM_NODE_HOST`.
# Гейтвей не проксирует игру, он выдаёт клиенту АДРЕС ноды — и по умолчанию это `127.0.0.1`,
# то есть ноутбук получил бы адрес самого себя и стучался бы в пустоту. Скрипт подставляет
# сюда реальный адрес машины в локальной сети.

param(
  [ValidateSet('single', 'cluster')]
  [string]$Mode = 'single',
  # Нод по умолчанию — ядра минус два (одно гейтвею, одно базе). На 9950X это 14.
  [int]$Nodes = 0,
  [int]$Port = 0,
  # Адрес этой машины в локальной сети. Пусто — определим сами.
  [string]$Host_ = '',
  # Библиотека сокетов: uws (умолчание, быстрее на 9–12 %) или ws.
  [string]$Ws = 'uws',
  # Боевая база вместо стендовой — если вдруг понадобится гонять по настоящим данным.
  [string]$Db = 'dungeon_test'
)

$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..\..'))

# ВЫБОР АДРЕСА — не мелочь. Кластер не проксирует игру: гейтвей выдаёт ботам адрес ноды,
# и если он ошибочный, боты уйдут в никуда, а выглядеть это будет как отказ сервера.
#
# Автоматика здесь честно ограничена. Проверено на этом же ноутбуке: у него два адреса
# с маршрутом по умолчанию — 192.168.1.69 (Wi-Fi) и 10.8.1.51 (AmneziaVPN), и по метрике
# интерфейса Windows предпочитает ВПН. Поэтому туннели из кандидатов выбрасываются по имени
# адаптера, а если после этого выбор всё ещё неоднозначен — скрипт не угадывает, а просит
# указать явно.
$tunnels = 'vpn|amnezia|wireguard|tailscale|zerotier|hamachi|tap|tun|openvpn|radmin'
$cands = Get-NetIPConfiguration |
  Where-Object { $null -ne $_.IPv4DefaultGateway -and $null -ne $_.IPv4Address } |
  Sort-Object { $_.NetIPv4Interface.InterfaceMetric }
$lan = @($cands | Where-Object { $_.InterfaceAlias -notmatch $tunnels })

if ($Host_ -eq '') {
  if ($lan.Count -eq 1) {
    $Host_ = $lan[0].IPv4Address.IPAddress
  } else {
    $show = $cands
    if ($lan.Count -gt 1) { $show = $lan }
    Write-Host "`nНе могу выбрать адрес сам. Кандидаты:" -ForegroundColor Yellow
    foreach ($c in $show) {
      Write-Host ("   {0,-16} {1}" -f $c.IPv4Address.IPAddress, $c.InterfaceAlias)
    }
    Write-Host "Перезапусти с нужным: -Host_ <адрес> (тот, по которому машину видит ноутбук).`n" -ForegroundColor Yellow
    exit 1
  }
}

# Общее для обоих режимов.
$env:DM_PG = "postgresql://dm:dmpass@127.0.0.1:5432/$Db"
$env:NODE_ENV = 'production'          # как в бою: dev-роуты закрыты, кэш ассетов включён
$env:DM_RATELIMIT = 'off'             # сотни ботов с одного адреса иначе упрутся в лимит Ф0.5
$env:DM_TELEMETRY_FLUSH_MS = '5000'
$env:DM_WS = $Ws

if ($Mode -eq 'single') {
  if ($Port -eq 0) { $Port = 3999 }
  $env:PORT = "$Port"
  Write-Host "`nОдин процесс на http://${Host_}:$Port (база $Db, транспорт $Ws)" -ForegroundColor Cyan
  Write-Host "С ноутбука:  dmload --base=http://${Host_}:$Port --from=100 --step=100 --max=1000`n"
  # probe.ts — тот же index.ts плюс печать CPU/RSS/лага цикла раз в три секунды.
  npx tsx packages/server/src/loadtest/probe.ts
} else {
  if ($Port -eq 0) { $Port = 3001 }
  if ($Nodes -eq 0) { $Nodes = [Math]::Max(1, [Environment]::ProcessorCount - 2) }
  $env:PORT = "$Port"
  $env:DM_ROLE = 'supervisor'
  $env:DM_NODES = "$Nodes"
  # Без этого гейтвей раздаст ws://127.0.0.1:порт — ноутбук пойдёт к себе и никого не найдёт.
  $env:DM_NODE_HOST = $Host_
  Write-Host "`nКластер: гейтвей http://${Host_}:$Port, нод $Nodes (порты $($Port+1)–$($Port+$Nodes))" -ForegroundColor Cyan
  Write-Host "Проверь, что фаервол пропускает весь диапазон — иначе боты войдут только на первую ноду."
  Write-Host "С ноутбука:  dmload --base=http://${Host_}:$Port --from=200 --step=200 --max=3000 --group=4`n"
  npx tsx packages/server/src/index.ts
}
