import type { App } from '../../core/app.js';
import { COLORS, mk, attachTooltip } from '../../ui/kit.js';

/**
 * КОШЕЛЬ МАТЕРИАЛОВ под сеткой инвентаря.
 *
 * Материалы ХРАНЯТСЯ кошельком (`SaveState.materials`), а не предметами: стекирования в игре нет
 * нигде, и сетка 10×6 забилась бы за один забег. Но ВЫГЛЯДЕТЬ они обязаны складом — иначе награда,
 * которая теперь составляет основной поток добычи, для игрока просто невидима (docs/ECONOMY.md, Ч1).
 */

/** Цвет по ступени: 1 — сталь, 2 — синева, 3 — латунь. Пока иконок нет, цвет и есть опознание. */
const TIER_HEX = ['#9aa6b2', '#7fb6e0', '#d0a24a'];

export function materialsView(app: App): HTMLElement {
  const wallet = app.state!.save.materials ?? {};
  const defs = app.config.get('craft-materials');

  const box = mk('div', 'margin-top:14px;width:100%');
  box.append(mk('p', `font-size:12px;color:${COLORS.dim};margin:0 0 8px`, 'Материалы'));

  // Порядок — как в конфиге (семьями по ступеням), чтобы склад не прыгал между открытиями панели.
  const owned = defs.filter((d) => (wallet[d.id] ?? 0) > 0);
  if (owned.length === 0) {
    box.append(mk('div', 'font-size:12px;color:#666',
      'Пусто. Материалы падают с убитых — с того, что на них надето.'));
    return box;
  }

  const row = mk('div', 'display:flex;flex-wrap:wrap;gap:6px');
  for (const d of owned) {
    const hex = TIER_HEX[Math.min(TIER_HEX.length, Math.max(1, d.tier)) - 1]!;
    const chip = mk('div',
      `display:flex;align-items:center;gap:6px;border:1px solid ${hex}55;border-radius:6px;` +
      `padding:4px 8px;background:${COLORS.bg};font-size:12px`);
    chip.append(mk('span', `width:10px;height:10px;border-radius:2px;background:${hex};display:inline-block`));
    chip.append(mk('span', `color:${hex}`, d.name));
    chip.append(mk('b', '', `×${wallet[d.id]}`));
    attachTooltip(chip, () =>
      `<b style="color:${hex}">${d.name}</b><br>Ступень ${d.tier}` +
      (d.sellPrice > 0 ? `<br>Продажа: ${d.sellPrice} за штуку` : ''));
    row.append(chip);
  }
  box.append(row);
  return box;
}
