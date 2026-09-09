#!/usr/bin/env bash
# Очная ставка двух стендов на одном сервере.
#
# ПОЧЕМУ ЧЕТЫРЕ ПРОГОНА, А НЕ ДВА. Разброс повтора измерен и он немал: RTT гуляет на четверть,
# CPU сервера на пять пунктов между двумя ОДИНАКОВЫМИ прогонами подряд. Значит один прогон
# против одного ничего не доказывает. Гоняем каждый стенд дважды и вперемешку (Node, Rust,
# Node, Rust): если разница между стендами больше, чем разница между повторами одного стенда,
# она настоящая.
#
# ЧТО УРАВНЕНО. Боты Node разбирают двоичные кадры и сверяют контрольные суммы — значит и здесь
# зрячими идут ВСЕ (--see=999), иначе сравнивались бы разные работы, а не разные языки.
# Сервер перед каждым прогоном поднимается заново: комната живёт час после выхода последнего
# игрока, и без перезапуска ступени становятся несравнимы.
set -e
cd "$(dirname "$0")/../.."
OUT="${1:?куда складывать логи}"
mkdir -p "$OUT"

RAMP="--from=50 --step=50 --max=250 --secs=20 --warmup=8"

for PASS in 1 2; do
  bash tools/dmload/restart-server.sh "$OUT/srv.log" >/dev/null
  echo "── Node, проход $PASS ──"
  npm run bench:ramp -- $RAMP 2>&1 | tee "$OUT/node_$PASS.log" | grep -E "ботов|ЁМКОСТЬ"

  bash tools/dmload/restart-server.sh "$OUT/srv.log" >/dev/null
  echo "── Rust, проход $PASS ──"
  ( cd tools/dmload && ./target/release/dmload.exe --base=http://127.0.0.1:3999 \
      $RAMP --threads=2 --see=999 --out="$OUT/rust_$PASS.json" ) \
    2>&1 | tee "$OUT/rust_$PASS.log" | grep -E "ботов |ЁМКОСТЬ|сверок"
done

echo "── сравнение прогонов Rust между собой (это и есть шум) ──"
( cd tools/dmload && ./target/release/dmload.exe --compare="$OUT/rust_1.json,$OUT/rust_2.json" )
