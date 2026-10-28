/**
 * Кастом-поле `monster.derive` — ТОЧЕЧНОЕ переопределение коэффициентов деривации ДЛЯ ЭТОГО моба.
 *
 * Пусто/null → моб целиком берёт коэффициенты из общей страницы «Деривация» (`monster-derive`).
 * Включённая галка на строке → этот ОДИН коэффициент у моба свой; остальные продолжают ехать за общими.
 * Одна истина: движок (`generateMonster`) кладёт оверрайд ПОВЕРХ базы — те же коэффициенты, что видит редактор.
 *
 * ⚠ 13.10 БЛОКЕР ПЛАНА «Монстры: план по силе». Раньше кнопка «Переопределить» копировала ВЕСЬ блок общих
 * значений, а схема требовала все 16 ключей — иначе не сохранялось. Итог: у 18 из 19 монстров в `monsters.json`
 * лежала полная копия базы, и правка общей страницы «Деривация» меняла РОВНО ОДНОГО монстра из 19 (того, у
 * которого копии не было). Поэтому: схема стала частичной, движок сливает, а редактор пишет только тронутое.
 */

const h = (tag: string, css: string, txt = ''): HTMLElement => { const e = document.createElement(tag); e.style.cssText = css; if (txt) e.textContent = txt; return e; };

/** Человеко-читаемые подписи коэффициентов (что даёт каждая характеристика). */
const LABELS: Record<string, string> = {
  levelGrowth: 'Рост атрибутов /ур. (доля)',
  hpBase: 'HP базовый', hpPerVit: 'HP за Выносливость', hpPerLevel: 'HP за уровень',
  hpVitPower: 'Крутизна HP (степень)',
  bossRoomDepthPct: 'Босс-комната глубже этажа (доля уровня, мин. +1)',
  dmgPerAttr: 'Урон за атрибут (доля оружия)', armorPerStr: 'Броня за Силу',
  accBase: 'Меткость базовая', accPerLevel: 'Меткость за уровень',
  evadeBase: 'Уворот базовый', evadePerDex: 'Уворот за Ловкость',
  iasPerDex: 'Скор. атаки за Ловкость', critPerDex: 'Крит за Ловкость',
  resistPerLevel: 'Сопр. за уровень', xpBase: 'XP базовый', xpPerLevel: 'XP за уровень',
};
const ORDER = ['levelGrowth', 'hpBase', 'hpPerVit', 'hpPerLevel', 'hpVitPower', 'dmgPerAttr', 'armorPerStr', 'accBase', 'accPerLevel', 'evadeBase', 'evadePerDex', 'iasPerDex', 'critPerDex', 'resistPerLevel', 'xpBase', 'xpPerLevel', 'bossRoomDepthPct'];
const TIER_KEYS = ['weak', 'medium', 'strong', 'boss'];
const TIER_LABELS: Record<string, string> = { weak: 'слабый', medium: 'средний', strong: 'сильный', boss: 'босс' };
/** Группы множителей по тиру: ключ объекта в деривации → подпись блока. */
const TIER_GROUPS: { key: string; title: string }[] = [
  { key: 'tierXp', title: 'XP-множитель по тиру' },
  { key: 'tierHp', title: 'HP-множитель по тиру (разброс пачки)' },
  { key: 'tierDmg', title: 'Урон-множитель по тиру' },
];

const BTN = 'padding:5px 10px;cursor:pointer;background:#2c2c3a;color:#e8e8f0;border:1px solid #3c3c4a;border-radius:5px;font-size:12px';
const INP = 'padding:4px 6px;background:#0f0f16;color:#e8e8f0;border:1px solid #2c2c3a;border-radius:4px;font-size:12px;width:100%';
const INP_OFF = `${INP};opacity:.45`;
function mkBtn(text: string, on: () => void): HTMLButtonElement { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.style.cssText = BTN; b.addEventListener('click', on); return b; }

/**
 * Одна строка «галка + число». Галка снята → ключа в объекте НЕТ (едет за общим), поле показывает общее
 * значение и не редактируется. Галка стоит → ключ появляется со текущим общим значением как стартовым.
 */
function row(label: string, own: boolean, globalVal: number, ownVal: number, onOwn: (on: boolean) => void, onVal: (n: number) => void): HTMLElement[] {
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = own; cb.title = 'своё значение у этого моба';
  cb.style.cssText = 'cursor:pointer;margin:0';
  const inp = document.createElement('input');
  inp.type = 'number'; inp.step = 'any';
  inp.value = String(own ? ownVal : globalVal);
  inp.disabled = !own;
  inp.style.cssText = own ? INP : INP_OFF;
  cb.addEventListener('change', () => onOwn(cb.checked));
  inp.addEventListener('input', () => onVal(Number(inp.value) || 0));
  const lab = h('label', `font-size:12px;color:${own ? '#e0b040' : '#8a8a9a'}`, label);
  return [cb, lab, inp];
}

/** value — текущее переопределение (объект с ТРОНУТЫМИ ключами) или null/undefined. getGlobal — общие коэффициенты. */
export function renderDeriveOverride(value: unknown, onChange: (v: unknown) => void, getGlobal: () => Record<string, unknown>): HTMLElement {
  const wrap = h('div', 'border:1px solid #2c2c3a;border-radius:8px;padding:10px;background:#12121a');
  // set(v) обновляет и модель (onChange), и локальный вид (rebuild) — иначе форма не переключит вид.
  const set = (v: unknown): void => { onChange(v); rebuild(v); };

  function rebuild(v: unknown): void {
    wrap.innerHTML = '';
    const cur = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    if (!cur) {
      wrap.appendChild(h('div', 'color:#9aa;font-size:12px;margin-bottom:8px', 'Берёт все коэффициенты из общей страницы «Деривация».'));
      wrap.appendChild(mkBtn('Переопределить отдельные коэффициенты', () => set({})));
      return;
    }
    const g = getGlobal();
    const touched = ORDER.filter((k) => cur[k] !== undefined).length
      + TIER_GROUPS.reduce((n, grp) => n + TIER_KEYS.filter((t) => (cur[grp.key] as Record<string, unknown> | undefined)?.[t] !== undefined).length, 0);

    const head = h('div', 'display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap');
    head.appendChild(h('div', 'color:#e0b040;font-size:12px;font-weight:600', touched ? `Своих коэффициентов: ${touched}` : 'Пока ничего не переопределено'));
    head.appendChild(mkBtn('✕ Убрать (всё из общих)', () => set(null)));
    wrap.appendChild(head);
    wrap.appendChild(h('div', 'font-size:11px;color:#8a8a9a;margin:0 0 8px', 'Галка = своё значение у этого моба. Без галки коэффициент едет за общей страницей «Деривация».'));

    const grid = h('div', 'display:grid;grid-template-columns:18px 1fr 88px;gap:4px 10px;align-items:center');
    for (const key of ORDER) {
      if (g[key] === undefined) continue;   // ключа нет в общей деривации — не предлагаем
      const own = cur[key] !== undefined;
      for (const el of row(LABELS[key] ?? key, own, Number(g[key] ?? 0), Number(cur[key] ?? 0),
        (on) => { if (on) cur[key] = Number(g[key] ?? 0); else delete cur[key]; set(cur); },
        (n) => { cur[key] = n; onChange(cur); })) grid.appendChild(el);
    }
    wrap.appendChild(grid);

    for (const grp of TIER_GROUPS) {
      const gt = g[grp.key] as Record<string, number> | undefined;
      if (!gt) continue;                    // группы нет в общей деривации — блок не рисуем
      wrap.appendChild(h('div', 'font-size:11px;color:#8a8a9a;margin:9px 0 3px;text-transform:uppercase;letter-spacing:.04em', grp.title));
      const tgrid = h('div', 'display:grid;grid-template-columns:18px 1fr 66px;gap:4px 10px;align-items:center');
      for (const tk of TIER_KEYS) {
        const own = (cur[grp.key] as Record<string, unknown> | undefined)?.[tk] !== undefined;
        for (const el of row(TIER_LABELS[tk] ?? tk, own, Number(gt[tk] ?? 0), Number((cur[grp.key] as Record<string, number> | undefined)?.[tk] ?? 0),
          (on) => {
            const box = (cur[grp.key] && typeof cur[grp.key] === 'object' ? cur[grp.key] : {}) as Record<string, unknown>;
            if (on) { box[tk] = Number(gt[tk] ?? 0); cur[grp.key] = box; } else {
              delete box[tk];
              if (!Object.keys(box).length) delete cur[grp.key]; else cur[grp.key] = box;
            }
            set(cur);
          },
          (n) => { const box = cur[grp.key] as Record<string, number>; box[tk] = n; onChange(cur); })) tgrid.appendChild(el);
      }
      wrap.appendChild(tgrid);
    }
  }

  rebuild(value);
  return wrap;
}
