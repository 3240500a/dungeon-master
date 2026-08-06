/**
 * Кастом-поле `monster.derive` — переопределение коэффициентов деривации ДЛЯ ЭТОГО моба.
 * Пусто/null → моб берёт коэффициенты из общей страницы «Деривация» (`monster-derive`). Кнопка
 * «Переопределить» авто-заполняет блок ТЕКУЩИМИ общими значениями → дальше дотюниваешь per-моб.
 * Одна истина: движок (`generateMonster`) читает `base.derive ?? global` — те же коэффициенты.
 */

const h = (tag: string, css: string, txt = ''): HTMLElement => { const e = document.createElement(tag); e.style.cssText = css; if (txt) e.textContent = txt; return e; };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Человеко-читаемые подписи коэффициентов (что даёт каждая характеристика). */
const LABELS: Record<string, string> = {
  levelGrowth: 'Рост атрибутов /ур. (доля)',
  hpBase: 'HP базовый', hpPerVit: 'HP за Выносливость', hpPerLevel: 'HP за уровень',
  dmgPerAttr: 'Урон за атрибут (доля оружия)', armorPerStr: 'Броня за Силу',
  accBase: 'Меткость базовая', accPerLevel: 'Меткость за уровень',
  evadeBase: 'Уворот базовый', evadePerDex: 'Уворот за Ловкость',
  iasPerDex: 'Скор. атаки за Ловкость', critPerDex: 'Крит за Ловкость',
  resistPerLevel: 'Сопр. за уровень', xpBase: 'XP базовый', xpPerLevel: 'XP за уровень',
};
const ORDER = ['levelGrowth', 'hpBase', 'hpPerVit', 'hpPerLevel', 'dmgPerAttr', 'armorPerStr', 'accBase', 'accPerLevel', 'evadeBase', 'evadePerDex', 'iasPerDex', 'critPerDex', 'resistPerLevel', 'xpBase', 'xpPerLevel'];
const TIER_LABELS: Record<string, string> = { weak: 'слабый', medium: 'средний', strong: 'сильный', boss: 'босс' };

const BTN = 'padding:5px 10px;cursor:pointer;background:#2c2c3a;color:#e8e8f0;border:1px solid #3c3c4a;border-radius:5px;font-size:12px';
const INP = 'padding:4px 6px;background:#0f0f16;color:#e8e8f0;border:1px solid #2c2c3a;border-radius:4px;font-size:12px;width:100%';
function mkBtn(text: string, on: () => void): HTMLButtonElement { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.style.cssText = BTN; b.addEventListener('click', on); return b; }
function numInput(val: number, on: (n: number) => void): HTMLInputElement {
  const i = document.createElement('input'); i.type = 'number'; i.step = 'any'; i.value = String(val ?? 0); i.style.cssText = INP;
  i.addEventListener('input', () => on(Number(i.value) || 0));
  return i;
}

/** value — текущее переопределение (объект) или null/undefined. getGlobal — текущие общие коэффициенты. */
export function renderDeriveOverride(value: unknown, onChange: (v: unknown) => void, getGlobal: () => Record<string, unknown>): HTMLElement {
  const wrap = h('div', 'border:1px solid #2c2c3a;border-radius:8px;padding:10px;background:#12121a');
  // set(v) обновляет и модель (onChange), и локальный вид (rebuild) — иначе форма не переключит вид.
  const set = (v: unknown): void => { onChange(v); rebuild(v); };

  function rebuild(v: unknown): void {
    wrap.innerHTML = '';
    const cur = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    if (!cur) {
      wrap.appendChild(h('div', 'color:#9aa;font-size:12px;margin-bottom:8px', 'Берёт коэффициенты из общей страницы «Деривация».'));
      wrap.appendChild(mkBtn('Переопределить для этого моба (из общих)', () => set(clone(getGlobal()))));
      return;
    }
    const head = h('div', 'display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap');
    head.appendChild(h('div', 'color:#e0b040;font-size:12px;font-weight:600', 'Своя деривация (переопределено)'));
    head.appendChild(mkBtn('↻ Сбросить к общим', () => set(clone(getGlobal()))));
    head.appendChild(mkBtn('✕ Убрать (брать из общих)', () => set(null)));
    wrap.appendChild(head);

    const grid = h('div', 'display:grid;grid-template-columns:1fr 88px;gap:4px 12px;align-items:center');
    for (const key of ORDER) {
      grid.appendChild(h('label', 'font-size:12px;color:#cfd0da', LABELS[key] ?? key));
      grid.appendChild(numInput(cur[key] as number, (n) => { cur[key] = n; onChange(cur); }));
    }
    wrap.appendChild(grid);

    wrap.appendChild(h('div', 'font-size:11px;color:#8a8a9a;margin:9px 0 3px;text-transform:uppercase;letter-spacing:.04em', 'XP-множитель по тиру'));
    const tier = (cur.tierXp && typeof cur.tierXp === 'object' ? cur.tierXp : {}) as Record<string, number>;
    cur.tierXp = tier;
    const tgrid = h('div', 'display:grid;grid-template-columns:1fr 66px 1fr 66px;gap:4px 12px;align-items:center');
    for (const tk of ['weak', 'medium', 'strong', 'boss']) {
      tgrid.appendChild(h('label', 'font-size:12px;color:#cfd0da', TIER_LABELS[tk]));
      tgrid.appendChild(numInput(tier[tk] ?? 0, (n) => { tier[tk] = n; onChange(cur); }));
    }
    wrap.appendChild(tgrid);
  }

  rebuild(value);
  return wrap;
}
