import type { App } from '../../core/app.js';
import { COLORS, mk, attachTooltip } from '../../ui/kit.js';

/**
 * КОШЕЛЬ МАТЕРИАЛОВ под сеткой инвентаря.
 *
 * Материалы ХРАНЯТСЯ кошельком (`SaveState.materials`), а не предметами: стекирования в игре нет
 * нигде, и сетка 10×6 забилась бы за один забег. Но ВЫГЛЯДЕТЬ они обязаны складом — иначе награда,
 * которая теперь составляет основной поток добычи, для игрока просто невидима (docs/ECONOMY.md, Ч1).
 *
 * ⚠ Рисуем ВСЕ материалы конфига, а не только имеющиеся: склад с пустыми ячейками показывает,
 * что вообще бывает и чего не хватает. Показывай мы только ненулевые — новый персонаж видел бы
 * пустое место и не знал бы, что кошелёк существует.
 *
 * Раскладка — строка на семью, столбец на ступень: так видно и «чего у меня нет», и «какая
 * ступень уже пошла с глубины».
 */

/** Цвет по ступени: 1 — сталь, 2 — синева, 3 — латунь. Пока иконок нет, цвет и есть опознание. */
const TIER_HEX = ['#9aa6b2', '#7fb6e0', '#d0a24a'];

/** Подпись семьи: берём из конфига только id, а человеческое имя — отсюда. */
const FAMILY_LABEL: Record<string, string> = {
  iron: 'Железо',
  wood: 'Дерево',
  cloth: 'Ткань',
  hide: 'Кожа',
  plate: 'Пластины',
};

export function materialsView(app: App): HTMLElement {
  const wallet = app.state!.save.materials ?? {};
  const defs = app.config.get('craft-materials').filter((d) => d.enabled);

  const box = mk('div', 'margin-top:14px;width:100%');
  const total = defs.reduce((n, d) => n + (wallet[d.id] ?? 0), 0);
  const head = mk('div', 'display:flex;align-items:baseline;gap:8px;margin:0 0 8px');
  head.append(mk('span', `font-size:12px;color:${COLORS.dim}`, 'Материалы'));
  head.append(mk('span', 'font-size:11px;color:#666', total > 0 ? `всего ${total}` : 'падают с убитых — с того, что на них надето'));
  box.append(head);

  if (defs.length === 0) { // конфиг ещё не доехал (старый сервер) — молчим, а не падаем
    box.append(mk('div', 'font-size:12px;color:#666', 'Материалы не настроены в конфиге.'));
    return box;
  }

  // Порядок семей — как они впервые встречаются в конфиге: склад не должен прыгать между открытиями.
  const families: string[] = [];
  for (const d of defs) if (!families.includes(d.family)) families.push(d.family);

  const grid = mk('div', 'display:flex;flex-direction:column;gap:4px');
  for (const fam of families) {
    const row = mk('div', 'display:flex;align-items:center;gap:6px');
    row.append(mk('div', `width:78px;font-size:11px;color:${COLORS.dim};text-align:right`, FAMILY_LABEL[fam] ?? fam));
    for (const d of defs.filter((x) => x.family === fam).sort((a, b) => a.tier - b.tier)) {
      const have = wallet[d.id] ?? 0;
      const hex = TIER_HEX[Math.min(TIER_HEX.length, Math.max(1, d.tier)) - 1]!;
      const cell = mk('div',
        `min-width:54px;height:30px;box-sizing:border-box;border-radius:6px;padding:0 8px;` +
        `display:flex;align-items:center;justify-content:center;gap:5px;font-size:12px;` +
        `background:${COLORS.panel2};border:1px solid ${have > 0 ? `${hex}88` : COLORS.border};` +
        `color:${have > 0 ? hex : '#4a4a4a'}`);
      cell.append(mk('span', `width:8px;height:8px;border-radius:2px;display:inline-block;background:${have > 0 ? hex : '#3a3a3a'}`));
      cell.append(mk('b', '', String(have)));
      attachTooltip(cell, () =>
        `<b style="color:${hex}">${d.name}</b><br>Ступень ${d.tier} · в кошельке ${have}` +
        (d.sellPrice > 0 ? `<br>Продажа: ${d.sellPrice} за штуку` : ''));
      row.append(cell);
    }
    grid.append(row);
  }
  box.append(grid);
  return box;
}
