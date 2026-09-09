#!/usr/bin/env pwsh
# Подготовка ВТОРОЙ МАШИНЫ под РАБОЧЕЕ МЕСТО: игра, поз-редактор, редактор конфигов, ИИ-генератор.
#
# Это надстройка над tools\deploy\setup-stand.ps1, а не его замена: Node 24, PostgreSQL, git,
# роль dm, базы dungeon/dungeon_test и зависимости он уже проверяет и заводит, и это ровно та же
# машина (в комментарии того скрипта прямо упомянут 9950X). Здесь добавляется то, чего для стенда
# не требовалось: КЛЮЧ ДОСТУПА, первый администратор, порт шима генерации и — по ключу -Ai —
# тулчейн под движок анимаций.
#
#   powershell -ExecutionPolicy Bypass -File tools\deploy\setup-workstation.ps1
#   powershell -ExecutionPolicy Bypass -File tools\deploy\setup-workstation.ps1 -Admin вася -Ai
#
# Скрипт НИЧЕГО не ставит молча — чего нет, про то он скажет и даст точную команду.
# Полная инструкция «от чистой Windows до работы» — docs\SECOND_MACHINE.md.

param(
  # Ник аккаунта, которому выдать права администратора. Аккаунт заводится РЕГИСТРАЦИЕЙ В ИГРЕ;
  # скрипт его не создаёт (пароль пользователя — не дело установочного скрипта).
  [string]$Admin = '',
  # Проверить тулчейн под ИИ-генератор (Vulkan SDK, CMake, Ninja, Python).
  [switch]$Ai,
  # Порт шима генерации анимаций (tools/anim-ai).
  [int]$AnimPort = 8790,
  # Не гонять setup-stand.ps1 (если он уже прошёл).
  [switch]$SkipStand,
  [switch]$SkipFirewall
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root

function Say([string]$state, [string]$text) {
  $color = 'Gray'
  if ($state -eq 'ok')   { $color = 'Green' }
  if ($state -eq 'нет')  { $color = 'Red' }
  if ($state -eq 'надо') { $color = 'Yellow' }
  Write-Host ("  [{0,-4}] {1}" -f $state, $text) -ForegroundColor $color
}

# --- Общая часть: делегируем стендовому скрипту ---
if (-not $SkipStand) {
  Write-Host "`n=== Общая подготовка (setup-stand.ps1) ===" -ForegroundColor Cyan
  $standArgs = @('-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'setup-stand.ps1'))
  if ($SkipFirewall) { $standArgs += '-SkipFirewall' }
  & powershell @standArgs
  if ($LASTEXITCODE -ne 0) {
    Write-Host "`nОбщая подготовка не прошла — доделай её и запусти снова.`n" -ForegroundColor Yellow
    exit 1
  }
}

# --- Ключ доступа ---
# Инструментальные роуты (/api/dev/*) и шим генерации пускают по роли ЛИБО по этому ключу.
# Ключ нужен процессам (скриптам, шиму); людям — логин с ролью admin.
Write-Host "`n=== Ключ доступа ===" -ForegroundColor Cyan
$envFile = Join-Path $PSScriptRoot 'local.env.ps1'
if (Test-Path $envFile) {
  Say 'ok' "ключ уже есть: $envFile (в git не попадает)"
} else {
  # 48 байт из криптостойкого источника. Не Get-Random: он для игральных костей, а не для секретов.
  $bytes = New-Object byte[] 48
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $key = [Convert]::ToBase64String($bytes)
  @"
# Локальные секреты рабочего места. НЕ КОММИТИТЬ (файл в .gitignore).
# Подключать перед запуском:  . .\tools\deploy\local.env.ps1
`$env:DM_ADMIN_KEY = '$key'
`$env:ANIM_KEY     = '$key'
"@ | Out-File -FilePath $envFile -Encoding utf8
  Say 'ok' "ключ создан: $envFile"
}
Say ' ' 'подключать так:  . .\tools\deploy\local.env.ps1'

# --- Первый администратор ---
Write-Host "`n=== Права ===" -ForegroundColor Cyan
if ($Admin -eq '') {
  Say 'надо' 'ник не указан. Зарегистрируйся в игре, потом: npm run grant-admin -- <ник>'
  Say ' '   '  Без роли admin редакторы не смогут писать конфиги и публиковать контент.'
} else {
  & npm run grant-admin -- $Admin
  if ($LASTEXITCODE -eq 0) { Say 'ok' "роль admin у «$Admin»" }
  else { Say 'надо' "не вышло выдать роль «$Admin» — скорее всего аккаунта ещё нет (регистрация идёт в игре)" }
}

# --- Фаервол: порт шима ---
Write-Host "`n=== Фаервол ===" -ForegroundColor Cyan
if ($SkipFirewall) {
  Say 'надо' 'пропущено по ключу -SkipFirewall'
} else {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) {
    Say 'надо' 'нет прав администратора — запусти PowerShell от имени администратора, иначе вторая машина не достучится до шима'
  } else {
    # Только Private/Domain: сервис запускает процессы по запросу, публичным сетям его показывать нельзя.
    $name = 'dungeon-master рабочее место'
    Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP `
      -LocalPort @("$AnimPort", '5173', '5174') -Profile Private,Domain | Out-Null
    Say 'ok' "открыты TCP $AnimPort (шим), 5173 (клиент), 5174 (редактор конфигов) — Private и Domain"
  }
}

# --- Тулчейн под ИИ (по ключу) ---
if ($Ai) {
  Write-Host "`n=== Тулчейн ИИ-генератора ===" -ForegroundColor Cyan
  $need = @(
    @{ n = 'cmake';  cmd = 'cmake';  hint = 'winget install Kitware.CMake';         why = 'сборка kimodo.cpp (нужен 3.25+)' },
    @{ n = 'ninja';  cmd = 'ninja';  hint = 'winget install Ninja-build.Ninja';     why = 'сборка kimodo.cpp' },
    @{ n = 'git';    cmd = 'git';    hint = 'winget install Git.Git';               why = 'исходники движка' },
    @{ n = 'python'; cmd = 'python'; hint = 'winget install Python.Python.3.12';    why = 'запасной путь на PyTorch' }
  )
  foreach ($t in $need) {
    if ($null -eq (Get-Command $t.cmd -ErrorAction SilentlyContinue)) { Say 'нет' "$($t.n) — $($t.why). $($t.hint)" }
    else { Say 'ok' "$($t.n) на месте" }
  }
  # Vulkan — ГЛАВНОЕ на этой машине: GTX 1070 это Pascal, а PyTorch выбросил sm_61 (последние
  # колёса 2.6.0, CUDA 13 выкидывает Pascal целиком, bf16 требует sm_80+). Через Vulkan видеокарта
  # работает полностью — это единственный способ её задействовать. Подробности: docs\ANIM_AI_RESEARCH.md.
  if ($env:VULKAN_SDK -and (Test-Path $env:VULKAN_SDK)) { Say 'ok' "Vulkan SDK: $env:VULKAN_SDK" }
  else { Say 'нет' 'Vulkan SDK не найден (переменная VULKAN_SDK). winget install KhronosGroup.VulkanSDK' }
  Say ' ' 'веса и сам движок живут на ветке ai-engines: git worktree add ..\ai-engines ai-engines'
}

# --- Итог ---
$ips = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }).IPAddress
Write-Host "`n=== Готово ===" -ForegroundColor Cyan
Write-Host "  Адреса этой машины: $($ips -join ', ')"
Write-Host "  1) . .\tools\deploy\local.env.ps1     — подключить ключ"
Write-Host "  2) npm run dev                        — игра и поз-редактор (http://localhost:5173/pose-editor.html)"
Write-Host "  3) npm run editor                     — редактор конфигов (http://localhost:5174)"
Write-Host "  4) npm run anim-ai:stub               — шим генерации (проверка канала без движка)"
Write-Host "  Работа с другой машины: DM_API=http://<адрес>:3001 DM_LAN=1 npm run dev"
Write-Host "  Полная инструкция: docs\SECOND_MACHINE.md`n"
