/**
 * ⭐ СКОРОСТЬ ПО НАПРАВЛЕНИЮ ХОДА (07.10, `balance.moveDir`): множитель от угла между ходом и прицелом. Пять опорных
 * углов — вперёд 0°, вперёд-вбок 45°, вбок 90°, назад-вбок 135°, назад 180° — между ними линейно, лево = право.
 * Нет хода или выключено — 1.
 */
export interface MoveDirCfg { enabled: boolean; fwd: number; fwdSide: number; side: number; backSide: number; back: number }

export function moveDirMult(cfg: MoveDirCfg | undefined, mx: number, my: number, facing: number): number {
  if (!cfg || !cfg.enabled || (mx === 0 && my === 0)) return 1;
  let d = Math.abs(Math.atan2(my, mx) - facing) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;                     // 0…π: насколько ход отвернул от прицела
  const pts = [cfg.fwd, cfg.fwdSide, cfg.side, cfg.backSide, cfg.back];
  const f = Math.min(4, (d / Math.PI) * 4), i = Math.min(3, Math.floor(f));
  const v = pts[i]! + (pts[i + 1]! - pts[i]!) * (f - i);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}
