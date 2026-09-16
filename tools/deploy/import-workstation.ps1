#!/usr/bin/env pwsh
# ПЕРЕЕЗД НА ДРУГУЮ МАШИНУ, шаг 2 из 2 — запускать на НОВОЙ машине из распакованного пакета.
#
# Пакет собирает tools\deploy\export-workstation.ps1 на старой машине. Этот скрипт:
#   1) разворачивает репозитории из снимков: все ветки, непушеные коммиты, незакоммиченные правки,
#      файлы вне git; origin смотрит на GitHub, как и было;
#   2) готовит машину штатным setup-workstation.ps1 (роль dm, базы, npm ci, ключ, фаервол);
#   3) восстанавливает базу `dungeon` и сверяет число строк с описью пакета;
#   4) кладёт арт, память и настройки Claude Code туда, где их ищет Claude на ЭТОЙ машине.
#
#   powershell -ExecutionPolicy Bypass -File .\import-workstation.ps1
#   powershell -ExecutionPolicy Bypass -File .\import-workstation.ps1 -Root D:\work
#
# Повторный запуск безопасен: готовые репозитории не трогаются, более новые файлы не
# перезаписываются, база, в которой уже есть аккаунты, без -ForceDb не затирается.

param(
  # Куда класть проекты. Тот же путь, что на старой машине, — тогда совпадут и пути в памяти Claude.
  [string]$Root = 'C:\work\Games_Art\Games_Art',
  [string]$ClaudeHome = '',
  [string]$PgUrl = 'postgresql://dm:dmpass@127.0.0.1:5432/dungeon',
  [switch]$SkipSetup,
  [switch]$SkipDb,
  # Перезаписать снимком базу, в которой уже есть аккаунты.
  [switch]$ForceDb
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PGCLIENTENCODING = 'UTF8'
$pack = $PSScriptRoot
if ($ClaudeHome -eq '') { $ClaudeHome = Join-Path $env:USERPROFILE '.claude' }
$script:bad = 0

function Say([string]$state, [string]$text) {
  $color = 'Gray'
  if ($state -eq 'ok')   { $color = 'Green' }
  if ($state -eq 'нет')  { $color = 'Red' }
  if ($state -eq 'надо') { $color = 'Yellow' }
  Write-Host ("  [{0,-4}] {1}" -f $state, $text) -ForegroundColor $color
}
# См. export-workstation.ps1: прогресс в stderr не должен становиться исключением.
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
  if ($LASTEXITCODE -ge 8) { throw "robocopy $src -> $dst : код $LASTEXITCODE" }
  $global:LASTEXITCODE = 0
}
function Find-PgTool([string]$name) {
  $c = Get-Command $name -ErrorAction SilentlyContinue
  if ($null -ne $c) { return $c.Source }
  $f = Get-ChildItem 'C:\Program Files\PostgreSQL' -Filter "$name.exe" -Recurse -ErrorAction SilentlyContinue |
    Sort-Object { [double](($_.Directory.Parent.Name) -replace '[^0-9.]', '') } -Descending | Select-Object -First 1
  if ($null -ne $f) { return $f.FullName }
  return $null
}
function Count-Files([string]$dir) {
  if (-not (Test-Path $dir)) { return 0 }
  return @(Get-ChildItem $dir -Recurse -File -ErrorAction SilentlyContinue).Count
}
function Psql1([string]$sql) { return "$(Capture $script:psql @('-X', '-A', '-t', '-d', $PgUrl, '-c', $sql))".Trim() }

$mf = Join-Path $pack 'manifest.json'
if (-not (Test-Path $mf)) {
  Write-Host "`nРядом со скриптом нет manifest.json — запускай его из распакованного пакета.`n" -ForegroundColor Red
  exit 1
}
$m = [IO.File]::ReadAllText($mf, [Text.Encoding]::UTF8) | ConvertFrom-Json
Write-Host "`nПакет от $($m.created) с машины $($m.machine) -> $Root" -ForegroundColor Cyan

# --- Окружение ---
Write-Host "`n=== Проверка окружения ===" -ForegroundColor Cyan
$ok = $true
if ($null -eq (Get-Command git -ErrorAction SilentlyContinue)) { Say 'нет' 'git не найден: winget install Git.Git'; $ok = $false }
else { Say 'ok' "$(git --version)" }
if ($null -eq (Get-Command node -ErrorAction SilentlyContinue)) { Say 'нет' 'Node не найден: winget install OpenJS.NodeJS.LTS (нужен 24)'; $ok = $false }
else { Say 'ok' "Node $(node -v)" }
$pgRestore = Find-PgTool 'pg_restore'
$script:psql = Find-PgTool 'psql'
if (-not $SkipDb) {
  if ($null -eq $pgRestore -or $null -eq $script:psql) { Say 'нет' 'PostgreSQL не найден: winget install PostgreSQL.PostgreSQL.17'; $ok = $false }
  else { Say 'ok' "PostgreSQL: $(Split-Path (Split-Path $pgRestore -Parent) -Parent)" }
}
if (-not $ok) {
  Write-Host "`nПоставь недостающее и запусти снова — в НОВОМ окне PowerShell, иначе PATH останется старым.`n" -ForegroundColor Yellow
  exit 1
}

# --- Репозитории ---
Write-Host "`n=== Репозитории ===" -ForegroundColor Cyan
New-Item -ItemType Directory -Force $Root | Out-Null
$globalName = "$(Capture git @('config', '--global', 'user.name'))".Trim()
$dmDst = $null
$unityDst = $null
foreach ($prop in $m.repos.PSObject.Properties) {
  $key = $prop.Name; $r = $prop.Value
  $dst = Join-Path $Root $r.dir
  if ($key -eq 'dungeon_master') { $dmDst = $dst }
  if ($key -eq 'unity') { $unityDst = $dst }

  if (Test-Path (Join-Path $dst '.git')) {
    Say 'ok' "${key}: уже есть ($dst) — историю не трогаю"
  } else {
    New-Item -ItemType Directory -Force (Split-Path $dst -Parent) | Out-Null
    # LFS при клонировании из файла полез бы за объектами в сеть — их кладём сами ниже.
    if ($r.lfs) { $env:GIT_LFS_SKIP_SMUDGE = '1' }
    try {
      if ((Exec git @('clone', '--quiet', '--no-checkout', (Join-Path $pack "git\$key.bundle"), $dst)) -ne 0) {
        Say 'нет' "${key}: не клонировался из снимка"; $script:bad++; continue
      }
      # В снимке нет HEAD, поэтому ветки заводятся руками — ровно как были, с теми же upstream.
      Exec git @('-C', $dst, 'checkout', '--quiet', '--no-track', '-B', $r.head, "origin/$($r.head)") | Out-Null
      foreach ($b in $r.branches) {
        if ($b.name -ne $r.head) { Exec git @('-C', $dst, 'branch', '--quiet', '--no-track', $b.name, "origin/$($b.name)") | Out-Null }
        if ($b.upstream) { Exec git @('-C', $dst, 'branch', '--quiet', "--set-upstream-to=$($b.upstream)", $b.name) | Out-Null }
      }
      if ($r.origin) { Exec git @('-C', $dst, 'remote', 'set-url', 'origin', $r.origin) | Out-Null }
      if ($r.lfs) {
        $lfsSrc = Join-Path $pack "git\$key-lfs"
        if (Test-Path $lfsSrc) { Copy-Tree $lfsSrc (Join-Path $dst '.git\lfs\objects') }
        Remove-Item Env:\GIT_LFS_SKIP_SMUDGE -ErrorAction SilentlyContinue
        if ((Exec git @('-C', $dst, 'lfs', 'checkout')) -ne 0) { Say 'надо' "${key}: git lfs checkout не прошёл (не стоит git-lfs?)" }
      }
    } finally { Remove-Item Env:\GIT_LFS_SKIP_SMUDGE -ErrorAction SilentlyContinue }

    $miss = @()
    foreach ($b in $r.branches) {
      $sha = "$(Capture git @('-C', $dst, 'rev-parse', '--verify', '--quiet', "refs/heads/$($b.name)"))".Trim()
      if ($sha -ne $b.sha) { $miss += $b.name }
    }
    if ($miss.Count) { Say 'нет' "${key}: ветки не совпали со снимком: $($miss -join ', ')"; $script:bad++ }
    else { Say 'ok' "${key}: $(@($r.branches).Count) веток совпали со снимком, рабочая $($r.head) -> $dst" }

    if ($r.wipPatch) {
      $patch = Join-Path $pack "wip\$key.patch"
      if ((Exec git @('-C', $dst, 'apply', '--whitespace=nowarn', $patch)) -eq 0) { Say 'ok' "${key}: незакоммиченные правки легли поверх" }
      else { Say 'надо' "${key}: патч с незакоммиченным не лёг — он лежит в $patch" }
    }
    # Коммиты без имени автора git не примет; глобального нет — берём то, что было на старой машине.
    if (-not $globalName -and $m.gitIdentity.name) {
      Exec git @('-C', $dst, 'config', 'user.name', $m.gitIdentity.name) | Out-Null
      Exec git @('-C', $dst, 'config', 'user.email', $m.gitIdentity.email) | Out-Null
    }
    # Сверка с GitHub — по возможности. Нет входа или сети — не беда: всё уже на диске.
    $env:GIT_TERMINAL_PROMPT = '0'; $env:GCM_INTERACTIVE = 'never'
    if ((Exec git @('-C', $dst, 'fetch', '--quiet', '--prune', 'origin')) -eq 0) {
      $n = "$(Capture git @('-C', $dst, 'rev-list', '--count', "origin/$($r.head)..$($r.head)"))".Trim()
      if ($n -and $n -ne '0') { Say 'надо' "${key}: на GitHub нет $n коммитов ветки $($r.head) — они только на дисках, запушь" }
      else { Say 'ok' "${key}: GitHub в курсе всех коммитов $($r.head)" }
    } else { Say ' ' "${key}: GitHub не ответил (нет входа?) — не страшно, всё уже на диске" }
    Remove-Item Env:\GIT_TERMINAL_PROMPT, Env:\GCM_INTERACTIVE -ErrorAction SilentlyContinue
  }

  # Файлы вне git (модели) — и в свежий клон, и в уже существующий: без них модели не загрузятся.
  $filesSrc = Join-Path $pack "files\$key"
  if (Test-Path $filesSrc) {
    Copy-Tree $filesSrc $dst @('/XO')
    Say 'ok' "${key}: файлы вне git на месте ($(@($r.files).Count))"
  }
}

# --- Подготовка машины ---
if (-not $SkipSetup) {
  $setup = if ($null -ne $dmDst) { Join-Path $dmDst 'tools\deploy\setup-workstation.ps1' } else { '' }
  if ($setup -eq '' -or -not (Test-Path $setup)) {
    Say 'нет' 'dungeon_master не развернулся — готовить машину не под что'; $script:bad++
  } else {
    Write-Host "`n=== Подготовка машины (setup-workstation.ps1) ===" -ForegroundColor Cyan
    Write-Host '  «ник не указан» ниже пропусти: аккаунт с ролью admin приедет вместе с базой.' -ForegroundColor DarkGray
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & powershell -ExecutionPolicy Bypass -File $setup
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    if ($code -ne 0) {
      Write-Host "`nПодготовка не прошла — доделай, что она просит, и запусти импорт снова (готовое не повторится).`n" -ForegroundColor Yellow
      exit 1
    }
  }
}

# --- База ---
if (-not $SkipDb -and $null -ne $m.db) {
  Write-Host "`n=== База ===" -ForegroundColor Cyan
  if ((Psql1 'select 1') -ne '1') {
    Say 'нет' "база недоступна ($PgUrl): нет роли dm или базы dungeon — их заводит setup-workstation.ps1"; $script:bad++
  } else {
    $users = 0
    if ((Psql1 "select to_regclass('public.users') is not null") -eq 't') { $users = [int64](Psql1 'select count(*) from users') }
    if ($users -gt 0 -and -not $ForceDb) {
      Say 'надо' "в базе уже $users аккаунтов — не затираю. Заменить снимком: добавь -ForceDb"
    } else {
      $dump = Join-Path $pack 'db\dungeon.dump'
      if ((Exec $pgRestore @('--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error', "--dbname=$PgUrl", $dump)) -ne 0) {
        Say 'нет' 'pg_restore упал — база НЕ восстановлена'; $script:bad++
      } else {
        $sql = "select table_name || '|' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name"
        $got = @{}
        foreach ($line in @(Capture $script:psql @('-X', '-A', '-t', '-d', $PgUrl, '-c', $sql))) {
          if (-not $line) { continue }
          $p = $line.Split('|'); $got[$p[0]] = [int64]$p[1]
        }
        $diff = @()
        foreach ($t in $m.db.tables.PSObject.Properties) {
          if (-not $got.ContainsKey($t.Name)) { $diff += "$($t.Name): таблицы нет" }
          elseif ($got[$t.Name] -ne [int64]$t.Value) { $diff += "$($t.Name): $($got[$t.Name]) из $($t.Value)" }
        }
        if ($diff.Count) { Say 'нет' "строки не сошлись: $($diff -join '; ')"; $script:bad++ }
        else { Say 'ok' "база восстановлена, все строки на месте: аккаунтов $($m.db.tables.users), ключей поз-редактора $($m.db.tables.pose_store)" }
        if (@($m.db.admins).Count) { Say 'ok' "в редакторы входи своим аккаунтом: $(@($m.db.admins) -join ', ') (роль admin приехала с базой)" }
      }
    }
  }
}

# --- Арт ---
if ($null -ne $m.art) {
  Write-Host "`n=== Арт-исходники ===" -ForegroundColor Cyan
  $leaf = Split-Path $m.art.dir -Leaf
  $artDst = Join-Path $Root $m.art.dir
  Copy-Tree (Join-Path $pack "art\$leaf") $artDst @('/XO')
  Say 'ok' "${leaf}: $(Count-Files $artDst) файлов -> $artDst"
}

# --- Claude Code ---
Write-Host "`n=== Claude Code ===" -ForegroundColor Cyan
$c = Join-Path $pack 'claude'
if ($null -ne $dmDst -and (Test-Path $dmDst)) {
  # Имя папки проекта = путь, где всё, кроме латиницы и цифр, заменено на «-».
  $projKey = (Resolve-Path $dmDst).Path -replace '[^A-Za-z0-9]', '-'
  $projDir = Join-Path $ClaudeHome "projects\$projKey"
  if (Test-Path (Join-Path $c 'memory')) {
    Copy-Tree (Join-Path $c 'memory') (Join-Path $projDir 'memory') @('/XO')
    Say 'ok' "память проекта: $(Count-Files (Join-Path $projDir 'memory')) файлов -> $projDir\memory"
  }
  if (Test-Path (Join-Path $c 'chats')) {
    Copy-Tree (Join-Path $c 'chats') $projDir @('/XO')
    Say 'ok' 'история чатов (claude --resume в папке проекта)'
  }
  $ls = Join-Path $c 'project-settings.local.json'
  $lsDst = Join-Path $dmDst '.claude\settings.local.json'
  if ((Test-Path $ls) -and -not (Test-Path $lsDst)) {
    New-Item -ItemType Directory -Force (Split-Path $lsDst -Parent) | Out-Null
    Copy-Item $ls $lsDst
    Say 'ok' 'разрешения проекта: .claude\settings.local.json'
  }
}
foreach ($d in @('skills', 'plans')) {
  if (Test-Path (Join-Path $c $d)) {
    Copy-Tree (Join-Path $c $d) (Join-Path $ClaudeHome $d) @('/XO')
    Say 'ok' "$d -> $(Join-Path $ClaudeHome $d)"
  }
}
if ((Test-Path (Join-Path $c 'CLAUDE.md')) -and -not (Test-Path (Join-Path $ClaudeHome 'CLAUDE.md'))) {
  Copy-Item (Join-Path $c 'CLAUDE.md') (Join-Path $ClaudeHome 'CLAUDE.md'); Say 'ok' 'CLAUDE.md'
}
# settings.json: своё на этой машине главнее — добавляются только ключи, которых здесь нет.
$sSrc = Join-Path $c 'settings.json'
$sDst = Join-Path $ClaudeHome 'settings.json'
if (Test-Path $sSrc) {
  New-Item -ItemType Directory -Force $ClaudeHome | Out-Null
  if (-not (Test-Path $sDst)) {
    Copy-Item $sSrc $sDst; Say 'ok' 'settings.json'
  } else {
    $have = [IO.File]::ReadAllText($sDst, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $from = [IO.File]::ReadAllText($sSrc, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $added = @()
    foreach ($p in $from.PSObject.Properties) {
      if ($null -eq $have.PSObject.Properties[$p.Name]) {
        $have | Add-Member -NotePropertyName $p.Name -NotePropertyValue $p.Value; $added += $p.Name
      }
    }
    if ($added.Count) {
      Copy-Item $sDst "$sDst.bak" -Force
      [IO.File]::WriteAllText($sDst, ($have | ConvertTo-Json -Depth 32), (New-Object System.Text.UTF8Encoding $false))
      Say 'ok' "settings.json: добавлено $($added -join ', ') (прежний — settings.json.bak)"
    } else { Say 'ok' 'settings.json: здесь уже всё есть' }
  }
}

# --- Итог ---
Write-Host "`n=== Итог ===" -ForegroundColor Cyan
if ($script:bad -gt 0) { Say 'нет' "проблем: $($script:bad) — смотри красные строки выше; повторный запуск доделает остальное" }
else { Say 'ok' 'всё перенесено' }
Write-Host "`n=== Дальше ===" -ForegroundColor Cyan
if ($null -ne $dmDst) {
  Write-Host "  1) Новое окно PowerShell в $dmDst :"
  Write-Host '       . .\tools\deploy\local.env.ps1 ; npm run dev'
  Write-Host '     игра http://localhost:5173/game3d.html · поз-редактор http://localhost:5173/pose-editor.html · конфиги: npm run editor'
  Write-Host "  2) Claude Code: открыть папку $dmDst — память уже на месте"
}
if ($null -ne $unityDst -and (Test-Path $unityDst)) {
  $ver = ''
  $pv = Join-Path $unityDst 'ProjectSettings\ProjectVersion.txt'
  if (Test-Path $pv) { foreach ($line in (Get-Content $pv)) { if ($line -match '^m_EditorVersion:\s*(\S+)') { $ver = $Matches[1] } } }
  Write-Host "  3) Unity: winget install Unity.UnityHub -> редактор $ver -> открыть $unityDst"
  Write-Host '     первое открытие долгое (Library собирается заново); для MCP for Unity: winget install astral-sh.uv'
}
Write-Host '  4) Ключ ИИ-шима в поз-редакторе ввести заново: он личный (pe_prefs) и в базу не попадает'
Write-Host ''
if ($script:bad -gt 0) { exit 1 }
