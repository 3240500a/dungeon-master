#!/usr/bin/env pwsh
# ПЕРЕЕЗД НА ДРУГУЮ МАШИНУ, шаг 1 из 2 — запускать на СТАРОЙ машине.
#
# git clone привозит только запушенное. Здесь собирается всё остальное, без чего новая машина
# откроется пустой:
#   * снимки обоих репозиториев (git bundle: все локальные ветки, в том числе непушеные коммиты),
#     незакоммиченные правки и файлы вне git (GLB в packages/server/assets);
#   * база Postgres `dungeon`: аккаунты, персонажи, правки конфига и ВЕСЬ контент поз-редактора
#     (клипы, риг, походки). Редактор тянет контент с сервера, но у свежей машины сервер пуст —
#     забирать не у кого;
#   * арт-исходники dungeon_master_art (не в git);
#   * Claude Code: память проекта, скиллы, планы, settings.json.
#
#   powershell -ExecutionPolicy Bypass -File tools\deploy\export-workstation.ps1
#   powershell -ExecutionPolicy Bypass -File tools\deploy\export-workstation.ps1 -WithChats
#
# Это СНИМОК на момент запуска. Перед переездом закрой остальные чаты и нажми «Опубликовать»
# в поз-редакторе (рабочая копия живёт в браузере и попадает в базу только так), потом запусти
# экспорт заново. Шаг 2 — import-workstation.ps1 из пакета на новой машине.
# Подробно: docs\SECOND_MACHINE.md, раздел «Переезд».

param(
  # Куда собрать пакет. По умолчанию — рядом с репозиторием: dm-transfer-<дата>.
  [string]$Out = '',
  [string]$UnityRepo = '',
  [string]$ArtDir = '',
  # Та же строка, что у сервера в разработке (packages/server/src/db/pool.ts).
  [string]$PgUrl = 'postgresql://dm:dmpass@127.0.0.1:5432/dungeon',
  # Взять и историю чатов Claude (сотни мегабайт; открываются через claude --resume).
  [switch]$WithChats,
  [switch]$NoZip
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PGCLIENTENCODING = 'UTF8'
$repo =(Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$games = Split-Path $repo -Parent
if ($Out -eq '') { $Out = Join-Path $games ('dm-transfer-' + (Get-Date -Format 'yyyyMMdd-HHmm')) }
if ($UnityRepo -eq '') { $UnityRepo = Join-Path $games 'ashes of the past\Ashes of the past' }
if ($ArtDir -eq '') { $ArtDir = Join-Path $games 'dungeon_master_art' }
$script:bad = 0

function Say([string]$state, [string]$text) {
  $color = 'Gray'
  if ($state -eq 'ok')   { $color = 'Green' }
  if ($state -eq 'нет')  { $color = 'Red' }
  if ($state -eq 'надо') { $color = 'Yellow' }
  Write-Host ("  [{0,-4}] {1}" -f $state, $text) -ForegroundColor $color
}

# Внешние программы пишут прогресс в stderr. В Windows PowerShell при 'Stop' это превращается
# в исключение, поэтому на время вызова режим ослабляется, а успех судится по коду возврата.
function Exec([string]$exe, [string[]]$argv) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & $exe @argv 2>&1 | ForEach-Object { Write-Host "         $_" -ForegroundColor DarkGray } }
  finally { $ErrorActionPreference = $prev }
  return $LASTEXITCODE
}
function Capture([string]$exe, [string[]]$argv) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $o = & $exe @argv 2>$null } finally { $ErrorActionPreference = $prev }
  return $o
}
function Copy-Tree([string]$src, [string]$dst, [string[]]$extra = @()) {
  $rc = @($src, $dst, '/E', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP') + $extra
  & robocopy @rc | Out-Null
  # У robocopy коды 0–7 — успех разной степени, 8 и выше — сбой.
  if ($LASTEXITCODE -ge 8) { throw "robocopy $src -> $dst : код $LASTEXITCODE" }
  $global:LASTEXITCODE = 0
}
function RelTo([string]$base, [string]$path) {
  $b = $base.TrimEnd('\') + '\'
  if ($path.StartsWith($b, [StringComparison]::OrdinalIgnoreCase)) { return $path.Substring($b.Length) }
  return (Split-Path $path -Leaf)
}
function Find-PgTool([string]$name) {
  $c = Get-Command $name -ErrorAction SilentlyContinue
  if ($null -ne $c) { return $c.Source }
  # Установщик Postgres кладёт утилиты в Program Files, но в PATH не добавляет.
  $f = Get-ChildItem 'C:\Program Files\PostgreSQL' -Filter "$name.exe" -Recurse -ErrorAction SilentlyContinue |
    Sort-Object { [double](($_.Directory.Parent.Name) -replace '[^0-9.]', '') } -Descending | Select-Object -First 1
  if ($null -ne $f) { return $f.FullName }
  return $null
}
function Count-Files([string]$dir) {
  if (-not (Test-Path $dir)) { return 0 }
  return @(Get-ChildItem $dir -Recurse -File -ErrorAction SilentlyContinue).Count
}

if (Test-Path $Out) { Write-Host "`nПапка $Out уже есть — укажи другую через -Out.`n" -ForegroundColor Yellow; exit 1 }
New-Item -ItemType Directory -Force $Out | Out-Null
Write-Host "`nПакет: $Out" -ForegroundColor Cyan

# --- Репозитории ---
# alsoIgnored — папки, где нужны и файлы из .gitignore (модели лежат вне git намеренно).
function Export-Repo([string]$key, [string]$path, [string[]]$alsoIgnored) {
  if (-not (Test-Path (Join-Path $path '.git'))) { Say 'нет' "${key}: репозитория нет — $path"; $script:bad++; return $null }
  $gitOut = Join-Path $Out 'git'
  New-Item -ItemType Directory -Force $gitOut | Out-Null

  $branches = @()
  foreach ($line in @(Capture git @('-C', $path, 'for-each-ref', 'refs/heads', '--format=%(refname:short)|%(objectname)|%(upstream:short)'))) {
    if (-not $line) { continue }
    $p = $line.Split('|')
    $branches += [ordered]@{ name = $p[0]; sha = $p[1]; upstream = $p[2] }
  }
  $head = "$(Capture git @('-C', $path, 'symbolic-ref', '--short', 'HEAD'))".Trim()
  $origin = "$(Capture git @('-C', $path, 'remote', 'get-url', 'origin'))".Trim()

  $bundle = Join-Path $gitOut "$key.bundle"
  if ((Exec git @('-C', $path, 'bundle', 'create', '--quiet', $bundle, '--branches', '--tags')) -ne 0) {
    Say 'нет' "${key}: git bundle не собрался"; $script:bad++; return $null
  }
  Capture git @('-C', $path, 'bundle', 'verify', '--quiet', $bundle) | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Say 'нет' "${key}: снимок не прошёл проверку"; $script:bad++; return $null
  }
  $ahead = @()
  foreach ($b in $branches) {
    if ($b.upstream) {
      $n = "$(Capture git @('-C', $path, 'rev-list', '--count', "$($b.upstream)..$($b.name)"))".Trim()
      if ($n -ne '0') { $ahead += "$($b.name) +$n" }
    } else {
      $n = "$(Capture git @('-C', $path, 'rev-list', '--count', $b.name, '--not', '--remotes'))".Trim()
      if ($n -ne '0') { $ahead += "$($b.name) +$n (нет на GitHub)" }
    }
  }
  $mb = [math]::Round((Get-Item $bundle).Length / 1MB, 1)
  Say 'ok' "${key}: $($branches.Count) веток, $mb МБ"
  if ($ahead.Count) { Say ' ' "  непушеное (в снимке есть): $($ahead -join ', ')" }

  # Незакоммиченные правки — патчем. Сам патч пишет git: перенаправление PowerShell портит байты.
  $wip = $false
  if ((Exec git @('-C', $path, 'diff', 'HEAD', '--quiet')) -ne 0) {
    $wipDir = Join-Path $Out 'wip'
    New-Item -ItemType Directory -Force $wipDir | Out-Null
    if ((Exec git @('-C', $path, 'diff', 'HEAD', '--binary', "--output=$(Join-Path $wipDir "$key.patch")")) -eq 0) {
      $wip = $true
      Say 'надо' "${key}: есть НЕЗАКОММИЧЕННЫЕ правки — уехали патчем, на новой машине лягут поверх"
    }
  }

  # Файлы вне git: неотслеживаемые + игнорируемые в указанных папках.
  $rels = @(Capture git @('-c', 'core.quotepath=false', '-C', $path, 'ls-files', '--others', '--exclude-standard'))
  foreach ($d in $alsoIgnored) { $rels += @(Capture git @('-c', 'core.quotepath=false', '-C', $path, 'ls-files', '--others', '--', $d)) }
  $rels = @($rels | Where-Object { $_ } | Sort-Object -Unique)
  $filesSize = 0
  foreach ($rel in $rels) {
    $win = $rel -replace '/', '\'
    $dst = Join-Path (Join-Path $Out "files\$key") $win
    New-Item -ItemType Directory -Force (Split-Path $dst -Parent) | Out-Null
    Copy-Item -LiteralPath (Join-Path $path $win) -Destination $dst
    $filesSize += (Get-Item -LiteralPath $dst).Length
  }
  if ($rels.Count) { Say 'ok' "${key}: файлов вне git — $($rels.Count), $([math]::Round($filesSize / 1MB, 1)) МБ" }

  $lfs = Join-Path $path '.git\lfs\objects'
  $hasLfs = Test-Path $lfs
  if ($hasLfs) { Copy-Tree $lfs (Join-Path $gitOut "$key-lfs") }

  return [ordered]@{
    dir = (RelTo $games $path); origin = $origin; head = $head; branches = $branches
    lfs = $hasLfs; wipPatch = $wip; files = $rels
  }
}

Write-Host "`n=== Репозитории ===" -ForegroundColor Cyan
$repos = [ordered]@{}
$r = Export-Repo 'dungeon_master' $repo @('packages/server/assets')
if ($null -ne $r) { $repos['dungeon_master'] = $r }
if (Test-Path $UnityRepo) {
  $r = Export-Repo 'unity' $UnityRepo @()
  if ($null -ne $r) { $repos['unity'] = $r }
} else { Say 'надо' "Unity-проект не найден: $UnityRepo (пропущен)" }

# --- База ---
Write-Host "`n=== База Postgres ===" -ForegroundColor Cyan
$db = $null
$pgDump = Find-PgTool 'pg_dump'
$psql = Find-PgTool 'psql'
if ($null -eq $pgDump -or $null -eq $psql) {
  Say 'нет' 'pg_dump/psql не найдены (PostgreSQL не установлен?) — база НЕ выгружена'; $script:bad++
} else {
  $dbDir = Join-Path $Out 'db'
  New-Item -ItemType Directory -Force $dbDir | Out-Null
  $dump = Join-Path $dbDir 'dungeon.dump'
  if ((Exec $pgDump @('--format=custom', "--file=$dump", "--dbname=$PgUrl")) -ne 0) {
    Say 'нет' 'pg_dump упал — сервер Postgres запущен? База НЕ выгружена'; $script:bad++
  } else {
    # Точные числа строк — по ним импорт проверит, что приехало всё.
    $sql = "select table_name || '|' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name"
    $tables = [ordered]@{}
    foreach ($line in @(Capture $psql @('-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', $PgUrl, '-c', $sql))) {
      if (-not $line) { continue }
      $p = $line.Split('|'); $tables[$p[0]] = [int64]$p[1]
    }
    $admins = @(Capture $psql @('-X', '-A', '-t', '-d', $PgUrl, '-c', "select username from users where role = 'admin' order by username") | Where-Object { $_ })
    $db = [ordered]@{ tables = $tables; admins = $admins }
    $mb = [math]::Round((Get-Item $dump).Length / 1MB, 1)
    Say 'ok' "dungeon: $($tables.Count) таблиц, $mb МБ; аккаунтов $($tables['users']), ключей поз-редактора $($tables['pose_store'])"
    Say 'надо' 'рабочая копия поз-редактора живёт в БРАУЗЕРЕ: неопубликованное в снимок не попало'
  }
}

# --- Арт ---
Write-Host "`n=== Арт-исходники ===" -ForegroundColor Cyan
$art = $null
if (Test-Path $ArtDir) {
  Copy-Tree $ArtDir (Join-Path $Out "art\$(Split-Path $ArtDir -Leaf)")
  $n = Count-Files $ArtDir
  $art = [ordered]@{ dir = (RelTo $games $ArtDir); files = $n }
  Say 'ok' "$(Split-Path $ArtDir -Leaf): $n файлов"
} else { Say 'надо' "нет папки $ArtDir (пропущено)" }

# --- Claude Code ---
Write-Host "`n=== Claude Code ===" -ForegroundColor Cyan
$claudeHome = Join-Path $env:USERPROFILE '.claude'
# Имя папки проекта = путь, где всё, кроме латиницы и цифр, заменено на «-».
$projKey = $repo -replace '[^A-Za-z0-9]', '-'
$projDir = Join-Path $claudeHome "projects\$projKey"
$cOut = Join-Path $Out 'claude'
New-Item -ItemType Directory -Force $cOut | Out-Null
$claude = [ordered]@{ projectKey = $projKey; memory = 0; skills = @(); plans = 0; chats = $false }
if (Test-Path (Join-Path $projDir 'memory')) {
  Copy-Tree (Join-Path $projDir 'memory') (Join-Path $cOut 'memory')
  $claude.memory = Count-Files (Join-Path $cOut 'memory')
  Say 'ok' "память проекта: $($claude.memory) файлов"
} else { Say 'надо' "памяти нет: $projDir\memory" }
if (Test-Path (Join-Path $claudeHome 'skills')) {
  Copy-Tree (Join-Path $claudeHome 'skills') (Join-Path $cOut 'skills')
  $claude.skills = @(Get-ChildItem (Join-Path $cOut 'skills') -Directory | ForEach-Object { $_.Name })
  Say 'ok' "скиллы: $($claude.skills -join ', ')"
}
if (Test-Path (Join-Path $claudeHome 'plans')) {
  Copy-Tree (Join-Path $claudeHome 'plans') (Join-Path $cOut 'plans')
  $claude.plans = Count-Files (Join-Path $cOut 'plans')
  Say 'ok' "планы: $($claude.plans)"
}
foreach ($f in @('settings.json', 'CLAUDE.md')) {
  if (Test-Path (Join-Path $claudeHome $f)) { Copy-Item (Join-Path $claudeHome $f) (Join-Path $cOut $f); Say 'ok' $f }
}
$localSettings = Join-Path $repo '.claude\settings.local.json'
if (Test-Path $localSettings) { Copy-Item $localSettings (Join-Path $cOut 'project-settings.local.json') }
if ($WithChats) {
  Copy-Tree $projDir (Join-Path $cOut 'chats') @('/XD', 'memory')
  $claude.chats = $true
  Say 'ok' "история чатов: $([math]::Round(((Get-ChildItem (Join-Path $cOut 'chats') -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB)) МБ"
} else {
  Say ' ' 'история чатов не взята (нужна — добавь -WithChats)'
}

# --- Манифест, импорт, инструкция ---
$gName = "$(Capture git @('-C', $repo, 'config', 'user.name'))".Trim()
$gMail = "$(Capture git @('-C', $repo, 'config', 'user.email'))".Trim()
$manifest = [ordered]@{
  created = (Get-Date).ToString('yyyy-MM-dd HH:mm'); machine = $env:COMPUTERNAME; gamesRoot = $games
  repos = $repos; db = $db; art = $art; claude = $claude
  gitIdentity = [ordered]@{ name = $gName; email = $gMail }
}
$utf8 = New-Object System.Text.UTF8Encoding $false
[IO.File]::WriteAllText((Join-Path $Out 'manifest.json'), ($manifest | ConvertTo-Json -Depth 8), $utf8)
Copy-Item (Join-Path $PSScriptRoot 'import-workstation.ps1') (Join-Path $Out 'import-workstation.ps1')
$readme = @"
Переезд dungeon_master — снимок от $($manifest.created), машина $env:COMPUTERNAME

НА НОВОЙ МАШИНЕ
1. Поставить (если ещё нет):
     winget install OpenJS.NodeJS.LTS          (нужен Node 24)
     winget install PostgreSQL.PostgreSQL.17   (запомнить пароль пользователя postgres)
     winget install Git.Git
2. Распаковать архив в любую папку.
3. PowerShell ОТ ИМЕНИ АДМИНИСТРАТОРА, в распакованной папке:
     powershell -ExecutionPolicy Bypass -File .\import-workstation.ps1
   Один раз спросит пароль postgres. Код ляжет в C:\work\Games_Art\Games_Art (другое место: -Root <папка>).
4. Открыть в Claude Code папку ...\dungeon_master — память подхватится сама.

Что внутри: git\ — снимки репозиториев; db\ — база; files\ — файлы вне git; art\ — арт;
claude\ — память и настройки Claude; manifest.json — опись для проверки.
В архиве база с аккаунтами (хэши паролей) — не выкладывать в открытый доступ.
"@
[IO.File]::WriteAllText((Join-Path $Out 'README.txt'), $readme, (New-Object System.Text.UTF8Encoding $true))

if (-not $NoZip) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = "$Out.zip"
  if (Test-Path $zip) { Remove-Item $zip }
  [System.IO.Compression.ZipFile]::CreateFromDirectory($Out, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
  Write-Host "`nАрхив: $zip ($([math]::Round((Get-Item $zip).Length / 1MB)) МБ)" -ForegroundColor Cyan
}

Write-Host "`n=== Итог ===" -ForegroundColor Cyan
if ($script:bad -gt 0) {
  Say 'нет' "проблем: $($script:bad) — пакет НЕПОЛНЫЙ, смотри красные строки выше"
  exit 1
}
Say 'ok' 'пакет собран. Перенеси архив на новую машину и запусти там import-workstation.ps1 (см. README.txt)'
Write-Host ''
