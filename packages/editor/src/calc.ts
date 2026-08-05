import { ConfigRegistry, newBotSave, botDerived, makePlayerModel, estimateAttack, type SaveState, type Attributes } from '@dm/shared';

/**
 * Вкладка «Калькулятор» — планировщик персонажа (à la d2planner). Шаг 2a: класс + уровень → бюджет
 * очков атрибутов (из balance) → распределение STR/DEX/INT/VIT → полный стат-блок теми же формулами,
 * что в игре (`deriveStats`/`makePlayerModel`/`estimateAttack`). Инвентарь/скиллы/монстр+TTK — 2b–2d.
 */
function regFromData(data: Record<string, unknown>): ConfigRegistry {
  const reg = new ConfigRegistry();
  reg.loadAll(data);
  return reg;
}

const ATTR: { k: keyof Attributes; short: string }[] = [
  { k: 'strength', short: 'СИЛ' }, { k: 'dexterity', short: 'ЛОВ' }, { k: 'intelligence', short: 'ИНТ' }, { k: 'vitality', short: 'ВЫН' },
];

let classId = '';
let level = 30;
const spent: Attributes = { strength: 0, dexterity: 0, intelligence: 0, vitality: 0 };

const h = (tag: string, css: string, html = ''): HTMLElement => { const e = document.createElement(tag); e.style.cssText = css; if (html) e.innerHTML = html; return e; };
const pctS = (x: number): string => `${Math.round(x * 100)}%`;

export function renderCalcPage(page: HTMLElement, data: Record<string, unknown>): void {
  page.innerHTML = '';
  const reg = regFromData(data);
  const classes = reg.get('classes');
  if (!classId || !classes.some((c) => c.id === classId)) classId = classes[0]?.id ?? '';
  const cls = classes.find((c) => c.id === classId) ?? classes[0];
  if (!cls) { page.appendChild(h('div', 'color:#9aa', 'Нет классов в конфиге.')); return; }
  const attrPerLevel = reg.get('balance').attributePointsPerLevel;
  const avail = attrPerLevel * Math.max(0, level - 1);
  // Понизили уровень → срезаем лишние вложенные очки (с наибольшего атрибута).
  let over = spent.strength + spent.dexterity + spent.intelligence + spent.vitality - avail;
  while (over > 0) { const k = ATTR.map((a) => a.k).reduce((a, b) => (spent[a] >= spent[b] ? a : b)); if (spent[k] <= 0) break; spent[k]--; over--; }

  page.appendChild(h('div', 'font-size:15px;font-weight:600;color:#e8e8f0;margin:2px 0 12px', '🧮 Калькулятор персонажа (планировщик)'));

  const wrap = h('div', 'display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start');
  const left = h('div', 'flex:0 0 300px;display:flex;flex-direction:column;gap:12px');
  const right = h('div', 'flex:1;min-width:280px');
  wrap.append(left, right);
  page.appendChild(wrap);

  const inp = 'padding:5px 8px;background:#0f0f16;color:#e8e8f0;border:1px solid #2c2c3a;border-radius:4px;font-size:13px';

  // ── класс + уровень ──
  const head = h('div', 'display:flex;gap:10px;align-items:flex-end');
  const classSel = document.createElement('select'); classSel.style.cssText = inp + ';flex:1';
  for (const c of classes) { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; if (c.id === classId) o.selected = true; classSel.appendChild(o); }
  classSel.addEventListener('change', () => { classId = classSel.value; spent.strength = spent.dexterity = spent.intelligence = spent.vitality = 0; renderCalcPage(page, data); });
  const lvlInp = document.createElement('input'); lvlInp.type = 'number'; lvlInp.min = '1'; lvlInp.max = '99'; lvlInp.value = String(level); lvlInp.style.cssText = inp + ';width:64px';
  lvlInp.addEventListener('change', () => { level = Math.max(1, Math.min(99, Number(lvlInp.value) || 1)); renderCalcPage(page, data); });
  head.append(field('Класс', classSel), field('Уровень', lvlInp));
  left.appendChild(head);

  // ── атрибуты ──
  const spentSum = spent.strength + spent.dexterity + spent.intelligence + spent.vitality;
  const remain = avail - spentSum;
  const attrBox = h('div', 'border:1px solid #2c2c3a;border-radius:8px;padding:10px;background:#14141c');
  attrBox.appendChild(h('div', `font-size:12px;color:#9aa;margin-bottom:8px`, `Очки атрибутов: <b style="color:${remain > 0 ? '#5dcaa5' : '#e8e8f0'}">${remain}</b> / ${avail} (${attrPerLevel}/ур)`));
  for (const { k, short } of ATTR) {
    const base = cls.startAttributes[k];
    const row = h('div', 'display:flex;align-items:center;gap:6px;margin:3px 0');
    row.appendChild(h('span', 'width:34px;font-size:12px;color:#9aa', short));
    row.appendChild(h('span', 'flex:1;font-size:13px;color:#e8e8f0', `${base + spent[k]} <span style="color:#6a6a7a">(${base}+${spent[k]})</span>`));
    const dec = miniBtn('−', () => { if (spent[k] > 0) { spent[k]--; renderCalcPage(page, data); } });
    const inc = miniBtn('+', () => { if (remain > 0) { spent[k]++; renderCalcPage(page, data); } });
    if (remain <= 0) inc.style.opacity = '0.4';
    if (spent[k] <= 0) dec.style.opacity = '0.4';
    row.append(dec, inc);
    attrBox.appendChild(row);
  }
  left.appendChild(attrBox);
  left.appendChild(h('div', 'font-size:11px;color:#6a6a7a', 'Инвентарь/скиллы/монстр+TTK — след. под-шаги (2b–2d). Пока: класс + атрибуты + стартовое оружие.'));

  // ── стат-блок ──
  const save = buildSave(reg, cls, level);
  const d = botDerived(reg, save);
  const m = makePlayerModel(reg, save, { useSkills: false });
  const hit = estimateAttack(m.derived, m.attrs, m.weapons[0], m.scaling, m.weights);
  const dps = hit / m.attackInterval;
  const wpn = save.equipment.weapon;

  const grid = h('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px');
  grid.appendChild(statCard('Ресурсы', [
    ['HP', `${Math.round(d.maxHp)} (+${d.hpRegen.toFixed(1)}/с)`],
    ['Мана', `${Math.round(d.maxMana)} (+${d.manaRegen.toFixed(1)}/с)`],
    ['Выносливость', `${Math.round(d.maxStamina)} (+${d.staminaRegen.toFixed(1)}/с)`],
  ]));
  grid.appendChild(statCard('Атака', [
    ['Оружие', wpn ? `${wpn.name}` : '—'],
    ['Урон удара', `~${Math.round(hit)}`],
    ['DPS', `~${Math.round(dps)}`],
    ['Скор. атаки', `${d.attackSpeed.toFixed(2)} (интервал ${m.attackInterval.toFixed(2)}с)`],
    ['Крит', `${pctS(d.critChance)} ×${d.critMultiplier.toFixed(2)}`],
    ['Скор. каста', `×${d.castSpeed.toFixed(2)}`],
    ['+урон / +статусы', `${pctS(d.damagePct)} / ${pctS(d.ailmentPct)}`],
  ]));
  grid.appendChild(statCard('Защита', [
    ['Армор', String(Math.round(d.armor))],
    ['Меткость / Уворот', `${Math.round(d.accuracy)} / ${Math.round(d.evade)}`],
    ['Блок', pctS(d.blockChance)],
    ['Резисты О/Х/М/Я', `${pctS(d.resFire)} / ${pctS(d.resCold)} / ${pctS(d.resLightning)} / ${pctS(d.resPoison)}`],
    ['Скорость', String(Math.round(d.moveSpeed))],
    ['Вампиризм HP/мана', `${pctS(d.lifeLeechPct)} / ${pctS(d.manaLeechPct)}`],
  ]));
  right.appendChild(grid);
}

function field(labelText: string, ctrl: HTMLElement): HTMLElement { const w = h('div', 'display:flex;flex-direction:column;gap:3px'); w.append(h('label', 'font-size:11px;color:#9aa', labelText), ctrl); return w; }
function miniBtn(t: string, on: () => void): HTMLButtonElement { const b = document.createElement('button'); b.type = 'button'; b.textContent = t; b.style.cssText = 'width:26px;height:26px;cursor:pointer;background:#2c2c3a;color:#e8e8f0;border:1px solid #3c3c4a;border-radius:4px;font-size:14px;line-height:1'; b.addEventListener('click', on); return b; }
function statCard(title: string, rows: [string, string][]): HTMLElement {
  const box = h('div', 'border:1px solid #2c2c3a;border-radius:8px;padding:12px 14px;background:#14141c');
  box.appendChild(h('div', 'color:#b8b8c8;font-weight:600;font-size:13px;margin-bottom:6px', title));
  for (const [k, v] of rows) { const r = h('div', 'display:flex;justify-content:space-between;gap:12px;font-size:12px;padding:2px 0'); r.append(h('span', 'color:#8a8a9a', k), h('span', 'color:#eaeaea;font-weight:500;text-align:right', v)); box.appendChild(r); }
  return box;
}
function buildSave(reg: ConfigRegistry, cls: { id: string; startAttributes: Attributes }, level: number): SaveState {
  const save = newBotSave(reg, cls.id);
  save.level = level;
  save.attributes = {
    strength: cls.startAttributes.strength + spent.strength,
    dexterity: cls.startAttributes.dexterity + spent.dexterity,
    intelligence: cls.startAttributes.intelligence + spent.intelligence,
    vitality: cls.startAttributes.vitality + spent.vitality,
  };
  return save;
}
