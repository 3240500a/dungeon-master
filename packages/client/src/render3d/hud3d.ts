/**
 * DOM-HUD 3D-клиента: полоски HP/маны/выносливости/опыта + строка «ур./золото/этаж».
 * Переиспользует элементы из `game3d.html` (#hp/#mana/#stam/#xp/#info). Читает `app.state` (авторитетный
 * с сервера через NetDriver3d): пулы — из снапшота, максимумы/опыт/золото — из сейва+производных.
 */
import type { App } from '../core/app.js';

export interface Hud3d { update(): void; }

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

export function mountHud3d(app: App): Hud3d {
  const g = (id: string): HTMLElement | null => document.getElementById(id);
  const hp = g('hp'), mana = g('mana'), stam = g('stam'), xp = g('xp'), info = g('info');
  const bar = (node: HTMLElement | null, cur: number, max: number): void => { if (node) node.style.width = `${clamp01(cur / Math.max(1, max)) * 100}%`; };
  return {
    update(): void {
      const st = app.state; if (!st) return;
      const d = st.derived();
      bar(hp, st.hp, d.maxHp); bar(mana, st.mana, st.effectiveMaxMana()); bar(stam, st.stamina, st.effectiveMaxStamina());
      const xt = app.config.get('balance').xpTable; const lvl = st.save.level;
      const cur = xt[lvl - 1] ?? 0, nx = xt[lvl] ?? cur + 1;
      bar(xp, st.save.xp - cur, Math.max(1, nx - cur));
      if (info) info.textContent = `Ур. ${lvl}  ·  Золото ${st.save.gold}  ·  ${st.depth > 0 ? `этаж ${st.depth}` : 'город'}`;
    },
  };
}
