@echo off
rem ⭐ КЛИКНИ ПО ЭТОМУ ФАЙЛУ — он заведёт агенту учётку с ролью admin на ЛОКАЛЬНОМ dev-сервере.
rem
rem Почему .cmd, а не .ps1: на этой машине выполнение PowerShell-сценариев запрещено политикой
rem («Невозможно загрузить файл … выполнение сценариев отключено»), а cmd под неё не подпадает.
rem
rem Всё делает tools/claudeAdmin.mjs — пароль случайный, на экран не выводится,
rem ложится в tools/deploy/local.claude.json (этот файл в .gitignore).
chcp 65001 >nul
cd /d "%~dp0.."
node "tools\claudeAdmin.mjs" %*
echo.
pause
