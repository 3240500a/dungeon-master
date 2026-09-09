#!/usr/bin/env bash
# Перезапуск сервера-под-стендом с ЧИСТОГО листа.
#
# Зачем: комната живёт ещё час после выхода последнего игрока (грейс на реконнект). Между
# прогонами они копятся, съедают память и мешают сравнивать ступени. Правило замера —
# сравнивать только подряд и только на свежем процессе.
SP="${1:?путь для лога}"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*probe.ts*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" >/dev/null 2>&1
sleep 2
( npm run loadtest:server > "$SP" 2>&1 & )
for i in $(seq 1 40); do
  sleep 1
  curl -s -m 2 http://127.0.0.1:3999/api/health >/dev/null 2>&1 && { sleep 3; echo "сервер поднят"; exit 0; }
done
echo "сервер не поднялся"; exit 1
