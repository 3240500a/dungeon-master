#!/usr/bin/env bash
# Сборка стенда. Обёртка нужна из-за линкера, а не из-за самого cargo.
#
# Rust здесь стоит целью x86_64-pc-windows-gnu, а MSVC-путь недоступен: Visual Studio есть,
# но без Windows SDK, то есть без kernel32.lib — линковать нечем. Значит нужен MinGW, и его
# путь обязан быть постоянным: раньше он лежал во временной папке сессии и пропадал вместе
# с ней.
#
# ГРАБЛЯ: путь в виде `C:/...` ломает разбор PATH в bash (двоеточие — разделитель), и сборка
# падает на `dlltool.exe: program not found`. Писать только как `/c/...`.
set -e
MINGW="${DM_MINGW:-/c/work/toolchain/mingw64/bin}"
if [ ! -x "$MINGW/dlltool.exe" ]; then
  echo "не найден MinGW в $MINGW — поставьте путь через DM_MINGW=/c/…/mingw64/bin" >&2
  exit 1
fi
PATH="$MINGW:$PATH" exec "${CARGO:-$HOME/.cargo/bin/cargo}" build --release "$@"
