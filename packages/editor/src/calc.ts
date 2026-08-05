import { ConfigRegistry, newBotSave, makePlayerModel, estimateAttack, generateMonster, generateItem, createRng, hitChance, armorMitigation, describeItem, type SaveState, type Attributes, type Item, type EquipSlot, type Rarity, type ItemLabels, type DerivedStats } from '@dm/shared';
import { makeHarness } from './gameHarness.js';
import { renderPassiveTree } from '@dm/client/modules/skills-passive/treeView.js';
import type { App } from '@dm/client/core/app.js';

/**
 * Вкладка «Калькулятор» — планировщик персонажа (à la d2planner). Вкладки: атрибуты (числом), экипировка
 * (слоты + тултип характеристик при наведении), мастерство (кликабельный атлас). Стат-блок + монстр + TTK —
 * теми же формулами, что в игре. Инвентарь/деревья не гейтят пререквизитами (это калькулятор).
 */
function regFromData(data: Record<string, unknown>): ConfigRegistry { const reg = new ConfigRegistry(); reg.loadAll(data); return reg; }

const ATTR: { k: keyof Attributes; short: string }[] = [
  { k: 'strength', short: 'Сила' }, { k: 'dexterity', short: 'Ловкость' }, { k: 'intelligence', short: 'Интеллект' }, { k: 'vitality', short: 'Выносливость' },
];
const SLOTS: { s: EquipSlot; ru: string }[] = [
  { s: 'weapon', ru: 'Оружие' }, { s: 'offhand', ru: 'Щит/офф' }, { s: 'helm', ru: 'Шлем' }, { s: 'chest', ru: 'Броня' },
  { s: 'gloves', ru: 'Перчатки' }, { s: 'boots', ru: 'Сапоги' }, { s: 'belt', ru: 'Пояс' }, { s: 'ring', ru: 'Кольцо' }, { s: 'amulet', ru: 'Амулет' },
];

let classId = '';
let level = 30;
let tab: 'attrs' | 'gear' | 'mastery' = 'gear';
const spent: Attributes = { strength: 0, dexterity: 0, intelligence: 0, vitality: 0 };
let monBaseId = '';
let monChampion = false;
const equipped: Partial<Record<EquipSlot, Item | null>> = {};
let itemRarity: '' | Rarity = '';
let rollSeed = 100;
const masteries: Record<string, number> = {};

const h = (tag: string, css: string, html = ''): HTMLElement => { const e = document.createElement(tag); e.style.cssText = css; if (html) e.innerHTML = html; return e; };
const pctS = (x: number): string => `${Math.round(x * 100)}%`;
const INP = 'padding:5px 8px;background:#0f0f16;color:#e8e8f0;border:1px solid #2c2c3a;border-radius:4px;font-size:13px';

// ── плавающий тултип ──
let tipEl: HTMLDivElement | null = null;
function hideTip(): void { if (tipEl) { tipEl.remove(); tipEl = null; } }
function showTip(inner: string, x: number, y: number): void {
  hideTip();
  tipEl = document.createElement('div');
  tipEl.style.cssText = 'position:fixed;z-index:9999;max-width:280px;background:#0b0b12;border:1px solid #3c3c4a;border-radius:6px;padding:8px 10px;font-size:12px;line-height:1.5;pointer-events:none;box-shadow:0 4px 16px #000a';
  tipEl.innerHTML = inner;
  document.body.appendChild(tipEl);
  const r = tipEl.getBoundingClientRect();
  tipEl.style.left = `${Math.min(x + 14, window.innerWidth - r.width - 8)}px`;
  tipEl.style.top = `${Math.min(y + 14, window.innerHeight - r.height - 8)}px`;
}

export function renderCalcPage(page: HTMLElement, data: Record<string, unknown>): void {
  page.innerHTML = ''; hideTip();
  const reg = regFromData(data);
  const classes = reg.get('classes');
  if (!classId || !classes.some((c) => c.id === classId)) classId = classes[0]?.id ?? '';
  const cls = classes.find((c) => c.id === classId) ?? classes[0];
  if (!cls) { page.appendChild(h('div', 'color:#9aa', 'Нет классов в конфиге.')); return; }
  const attrPerLevel = reg.get('balance').attributePointsPerLevel;
  const avail = attrPerLevel * Math.max(0, level - 1);
  let over = spent.strength + spent.dexterity + spent.intelligence + spent.vitality - avail;
  while (over > 0) { const k = ATTR.map((a) => a.k).reduce((a, b) => (spent[a] >= spent[b] ? a : b)); if (spent[k] <= 0) break; spent[k]--; over--; }

  page.appendChild(h('div', 'font-size:15px;font-weight:600;color:#e8e8f0;margin:2px 0 10px', '🧮 Калькулятор персонажа (планировщик)'));

  const wrap = h('div', 'display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start');
  const left = h('div', 'flex:0 0 340px;display:flex;flex-direction:column;gap:10px');
  const right = h('div', 'flex:1;min-width:300px;display:flex;flex-direction:column;gap:12px');
  wrap.append(left, right); page.appendChild(wrap);

  // ── класс + уровень ──
  const head = h('div', 'display:flex;gap:10px;align-items:flex-end');
  const classSel = document.createElement('select'); classSel.style.cssText = INP + ';flex:1';
  for (const c of classes) { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; if (c.id === classId) o.selected = true; classSel.appendChild(o); }
  classSel.addEventListener('change', () => { classId = classSel.value; spent.strength = spent.dexterity = spent.intelligence = spent.vitality = 0; for (const k of Object.keys(equipped)) delete equipped[k as EquipSlot]; for (const k of Object.keys(masteries)) delete masteries[k]; renderCalcPage(page, data); });
  const lvlInp = document.createElement('input'); lvlInp.type = 'number'; lvlInp.min = '1'; lvlInp.max = '99'; lvlInp.value = String(level); lvlInp.style.cssText = INP + ';width:64px';
  lvlInp.addEventListener('change', () => { level = Math.max(1, Math.min(99, Number(lvlInp.value) || 1)); renderCalcPage(page, data); });
  head.append(field('Класс', classSel), field('Уровень', lvlInp));
  left.appendChild(head);

  // ── вкладки ──
  const tabs = h('div', 'display:flex;gap:4px');
  for (const [id, name] of [['attrs', 'Атрибуты'], ['gear', 'Экипировка'], ['mastery', 'Мастерство']] as [typeof tab, string][]) {
    const b = document.createElement('button'); b.textContent = name;
    b.style.cssText = `flex:1;padding:6px 4px;cursor:pointer;border-radius:5px;border:1px solid #2c2c3a;background:${tab === id ? '#3a3a4c' : '#1c1c26'};color:#e8e8f0;font-size:12px`;
    b.addEventListener('click', () => { tab = id; renderCalcPage(page, data); });
    tabs.appendChild(b);
  }
  left.appendChild(tabs);

  const save = buildSave(reg, cls, level);
  const harness = makeHarness(data, save, () => renderCalcPage(page, data)); // мост «одна истина» с игрой
  const R = itemLabels(reg);

  if (tab === 'attrs') left.appendChild(attrsPanel(page, data, cls, avail));
  else if (tab === 'gear') left.appendChild(gearPanel(page, data, reg, save, R));
  else left.appendChild(masteryPanel(harness));

  // ── правая часть: стат-блок игрока + монстр + TTK (всегда) ──
  const d = harness.state!.derived(); // РЕАЛЬНАЯ деривация игры (GameState) — одна истина
  const m = makePlayerModel(reg, save, { useSkills: false });
  const hit = estimateAttack(m.derived, m.attrs, m.weapons[0], m.scaling, m.weights);
  const dps = hit / m.attackInterval;
  const grid = h('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px');
  grid.appendChild(statCard('Ресурсы', [
    ['HP', `${Math.round(d.maxHp)} (+${d.hpRegen.toFixed(1)}/с)`], ['Мана', `${Math.round(d.maxMana)} (+${d.manaRegen.toFixed(1)}/с)`], ['Выносливость', `${Math.round(d.maxStamina)} (+${d.staminaRegen.toFixed(1)}/с)`],
  ]));
  grid.appendChild(statCard('Атака', [
    ['Урон удара / DPS', `~${Math.round(hit)} / ~${Math.round(dps)}`], ['Скор. атаки', `${d.attackSpeed.toFixed(2)} (${m.attackInterval.toFixed(2)}с)`],
    ['Крит', `${pctS(d.critChance)} ×${d.critMultiplier.toFixed(2)}`], ['Скор. каста', `×${d.castSpeed.toFixed(2)}`], ['+урон / +статусы', `${pctS(d.damagePct)} / ${pctS(d.ailmentPct)}`],
  ]));
  grid.appendChild(statCard('Защита', [
    ['Армор', String(Math.round(d.armor))], ['Меткость / Уворот', `${Math.round(d.accuracy)} / ${Math.round(d.evade)}`], ['Блок', pctS(d.blockChance)],
    ['Резисты О/Х/М/Я', `${pctS(d.resFire)} / ${pctS(d.resCold)} / ${pctS(d.resLightning)} / ${pctS(d.resPoison)}`], ['Скорость', String(Math.round(d.moveSpeed))], ['Вампиризм HP/мана', `${pctS(d.lifeLeechPct)} / ${pctS(d.manaLeechPct)}`],
  ]));
  right.appendChild(grid);
  right.appendChild(monsterTtk(page, data, reg, d, m, hit, save));
}

// ── панель атрибутов (числом) ──
function attrsPanel(page: HTMLElement, data: Record<string, unknown>, cls: { startAttributes: Attributes }, avail: number): HTMLElement {
  const box = h('div', 'border:1px solid #2c2c3a;border-radius:8px;padding:12px;background:#14141c');
  const spentSum = spent.strength + spent.dexterity + spent.intelligence + spent.vitality;
  const remain = avail - spentSum;
  box.appendChild(h('div', `font-size:12px;color:#9aa;margin-bottom:10px`, `Свободных очков: <b style="color:${remain > 0 ? '#5dcaa5' : '#e8e8f0'}">${remain}</b> / ${avail}`));
  for (const { k, short } of ATTR) {
    const base = cls.startAttributes[k];
    const row = h('div', 'display:flex;align-items:center;gap:8px;margin:5px 0');
    row.appendChild(h('span', 'width:96px;font-size:13px;color:#cbd', short));
    const inp = document.createElement('input'); inp.type = 'number'; inp.min = String(base); inp.value = String(base + spent[k]); inp.style.cssText = INP + ';width:80px';
    inp.addEventListener('change', () => {
      const other = (spent.strength + spent.dexterity + spent.intelligence + spent.vitality) - spent[k];
      spent[k] = Math.max(0, Math.min(Math.round(Number(inp.value)) - base, avail - other));
      renderCalcPage(page, data);
    });
    row.appendChild(inp);
    row.appendChild(h('span', 'font-size:11px;color:#6a6a7a', `база ${base} + ${spent[k]}`));
    box.appendChild(row);
  }
  box.appendChild(h('div', 'font-size:11px;color:#6a6a7a;margin-top:6px', `${avail === 0 ? 'На 1 ур. очков нет — подними уровень.' : 'Впиши итоговое значение атрибута.'}`));
  return box;
}

// ── панель экипировки (слоты + тултип) ──
function gearPanel(page: HTMLElement, data: Record<string, unknown>, reg: ConfigRegistry, save: SaveState, R: ItemLabels): HTMLElement {
  const itemsBase = reg.get('items.base');
  const rarities = reg.get('rarities');
  const rarCol = (id: string): string => rarities.find((r) => r.id === id)?.color ?? '#c8c8c8';
  const rollFor = (slot: EquipSlot, baseId: string): void => {
    equipped[slot] = generateItem(itemsBase, reg.get('affixes'), reg.get('uniques'), {
      dropBias: 1, itemLevel: level, baseId, tiers: reg.get('item-tiers'), rarities, rareNames: reg.get('rare-names'),
      categoryWeights: reg.get('balance').loot.categoryWeights, forceRarity: itemRarity || undefined, maxReqTotal: reg.get('balance').maxTotalRequirement,
    }, createRng(rollSeed++));
  };
  const tipHtml = (item: Item): string => {
    const col = rarCol(item.rarity);
    const lines = describeItem(item, R).map((l) => `<div style="color:${l.affix ? col : '#dcdce4'}">${l.text}</div>`).join('');
    return `<div style="color:${col};font-weight:600;margin-bottom:4px">${item.name}</div>${lines}`;
  };

  const box = h('div', 'border:1px solid #2c2c3a;border-radius:8px;padding:10px;background:#14141c');
  const headRow = h('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px');
  headRow.appendChild(h('div', 'font-size:12px;color:#9aa', 'Экипировка — выбери базу (наведи на предмет = статы)'));
  const rarSel = document.createElement('select'); rarSel.style.cssText = INP + ';font-size:11px;padding:2px 6px';
  const rarOpts: [string, string][] = [['', 'натур.'], ...rarities.map((r) => [r.id, r.name] as [string, string])];
  for (const [v, t] of rarOpts) { const o = document.createElement('option'); o.value = v; o.textContent = t; if (v === itemRarity) o.selected = true; rarSel.appendChild(o); }
  rarSel.addEventListener('change', () => { itemRarity = rarSel.value as '' | Rarity; renderCalcPage(page, data); });
  headRow.appendChild(rarSel);
  box.appendChild(headRow);

  for (const { s, ru } of SLOTS) {
    const bases = itemsBase.filter((b) => (b as { slot?: EquipSlot }).slot === s);
    if (!bases.length) continue;
    const cur = equipped[s] !== undefined ? equipped[s] : save.equipment[s];
    const row = h('div', 'display:flex;align-items:center;gap:5px;margin:3px 0');
    row.appendChild(h('span', 'width:64px;font-size:11px;color:#9aa', ru));
    const sel = document.createElement('select'); sel.style.cssText = INP + ';flex:1;font-size:12px;padding:3px 6px';
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = '— пусто —'; sel.appendChild(empty);
    for (const b of bases) { const o = document.createElement('option'); o.value = b.id; o.textContent = b.name; if (cur?.baseId === b.id) o.selected = true; sel.appendChild(o); }
    sel.addEventListener('change', () => { if (!sel.value) equipped[s] = null; else rollFor(s, sel.value); renderCalcPage(page, data); });
    row.appendChild(sel);
    const rr = miniBtn('↻', () => { if (cur?.baseId) { rollFor(s, cur.baseId); renderCalcPage(page, data); } }); rr.title = 'Перекатать афиксы';
    if (!cur) rr.style.opacity = '0.4';
    row.appendChild(rr);
    box.appendChild(row);
    if (cur) {
      const nameEl = h('div', `font-size:11px;color:${rarCol(cur.rarity)};margin:0 0 4px 68px;cursor:help`, cur.name);
      nameEl.addEventListener('mousemove', (e) => showTip(tipHtml(cur), (e as MouseEvent).clientX, (e as MouseEvent).clientY));
      nameEl.addEventListener('mouseleave', hideTip);
      box.appendChild(nameEl);
    }
  }
  return box;
}

// ── панель мастерства: РЕАЛЬНЫЙ атлас игры (renderPassiveTree) через мост ──
function masteryPanel(harness: App): HTMLElement {
  const box = h('div', 'border:1px solid #2c2c3a;border-radius:8px;padding:6px;background:#0e0e15;height:520px;overflow:hidden');
  renderPassiveTree(harness, box); // зум/пан/пререквизиты — из игры 1:1; клик шлёт allocPassive в мост
  return box;
}

// ── монстр + TTK ──
function monsterTtk(page: HTMLElement, data: Record<string, unknown>, reg: ConfigRegistry, d: DerivedStats, m: ReturnType<typeof makePlayerModel>, hit: number, save: SaveState): HTMLElement {
  const box = h('div', 'display:flex;flex-direction:column;gap:12px');
  const mons = reg.get('monsters');
  if (!monBaseId || !mons.some((mm) => mm.id === monBaseId)) monBaseId = mons[0]?.id ?? '';
  if (!mons.length) return box;
  const monRow = h('div', 'display:flex;gap:10px;align-items:flex-end');
  const monSel = document.createElement('select'); monSel.style.cssText = INP + ';min-width:200px';
  for (const mm of mons) { const o = document.createElement('option'); o.value = mm.id; o.textContent = `${mm.name} [${mm.tier}]`; if (mm.id === monBaseId) o.selected = true; monSel.appendChild(o); }
  monSel.addEventListener('change', () => { monBaseId = monSel.value; renderCalcPage(page, data); });
  const champWrap = h('label', 'display:flex;align-items:center;gap:5px;font-size:13px;color:#e8e8f0;cursor:pointer');
  const champInp = document.createElement('input'); champInp.type = 'checkbox'; champInp.checked = monChampion;
  champInp.addEventListener('change', () => { monChampion = champInp.checked; renderCalcPage(page, data); });
  champWrap.append(champInp, document.createTextNode('чемпион'));
  monRow.append(field(`Монстр (ур.${level})`, monSel), field(' ', champWrap));
  box.appendChild(monRow);

  const mon = generateMonster(mons, reg.get('monster-gear'), reg.get('monster-affixes'), { baseId: monBaseId, depth: level - 1, forceChampion: monChampion, mderive: reg.get('monster-derive') }, createRng(1));
  const pHitCh = hitChance(d.accuracy, mon.evade);
  const pExp = hit * pHitCh * (1 - mon.blockChance) * (1 + d.critChance * (d.critMultiplier - 1)) * (1 - armorMitigation(mon.armor, save.level));
  const pDps = pExp / m.attackInterval;
  const monAvg = (mon.minDamage + mon.maxDamage) / 2;
  const mHitCh = hitChance(mon.accuracy, d.evade);
  const mExp = monAvg * mHitCh * (1 - d.blockChance) * (1 + mon.critChance * (mon.critMultiplier - 1)) * (1 - armorMitigation(d.armor, mon.level));
  const mDps = mExp * mon.attackSpeed;
  const ttkKill = mon.hp / Math.max(0.01, pDps), ttkDeath = d.maxHp / Math.max(0.01, mDps);
  const cols = h('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px');
  cols.appendChild(statCard(`Монстр: ${mon.name}`, [
    ['HP', `${mon.hp}${mon.hpRegen ? ` (+${mon.hpRegen}/с)` : ''}`], ['Урон / DPS', `${mon.minDamage}–${mon.maxDamage} / ${Math.round(mDps)}`],
    ['Меткость / Уворот / Армор', `${mon.accuracy} / ${mon.evade} / ${mon.armor}`], ['Блок / Крит / Скор', `${pctS(mon.blockChance)} / ${pctS(mon.critChance)} / ${mon.attackSpeed.toFixed(2)}`],
    ['AI / XP', `${mon.ai} / ${mon.xp}`], ['Афиксы', mon.affixes.length ? mon.affixes.join(', ') : '—'],
  ]));
  const win = ttkKill < ttkDeath;
  const ttk = statCard('TTK (время до убийства)', [
    ['Игрок → монстр', `~${ttkKill.toFixed(1)}с · ${Math.ceil(mon.hp / Math.max(0.01, pExp))} уд · поп. ${pctS(pHitCh)}`],
    ['Монстр → игрок', `~${ttkDeath.toFixed(1)}с · ${Math.ceil(d.maxHp / Math.max(0.01, mExp))} уд · поп. ${pctS(mHitCh)}`],
  ]);
  ttk.appendChild(h('div', `margin-top:8px;font-size:13px;font-weight:600;color:${win ? '#5dcaa5' : '#e0708a'}`, `${win ? '▲ Игрок побеждает' : '▼ Монстр побеждает'} · запас ×${(Math.max(ttkKill, ttkDeath) / Math.max(0.01, Math.min(ttkKill, ttkDeath))).toFixed(1)}`));
  cols.append(ttk); box.appendChild(cols);
  return box;
}

function itemLabels(reg: ConfigRegistry): ItemLabels {
  const nodes = reg.get('skill-tree').nodes;
  return {
    armorClass: (id) => reg.get('armor-classes').find((c) => c.id === id)?.name ?? id,
    weight: (id) => (reg.get('weapon-weights').find((w) => w.id === id)?.name ?? id).toLowerCase(),
    physSub: (id) => { const s = reg.get('phys-subtypes').find((x) => x.id === id); return s ? s.name.toLowerCase() : id; },
    skill: (id) => nodes.find((n) => n.id === id)?.name ?? id,
    dmgShort: (dt) => (dt === 'physical' ? (reg.get('damage-kinds').find((k) => k.id === 'physical')?.short ?? 'физ') : (reg.get('magic-subtypes').find((s) => s.id === dt)?.short ?? dt)),
  };
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
    strength: cls.startAttributes.strength + spent.strength, dexterity: cls.startAttributes.dexterity + spent.dexterity,
    intelligence: cls.startAttributes.intelligence + spent.intelligence, vitality: cls.startAttributes.vitality + spent.vitality,
  };
  for (const [slot, item] of Object.entries(equipped)) { if (item) save.equipment[slot as EquipSlot] = item; else delete save.equipment[slot as EquipSlot]; }
  save.masteries = masteries; // РЕФ — реальный атлас мастерства мутирует его
  const bal = reg.get('balance');
  const lv = Math.max(0, level - 1);
  const usedM = Object.values(masteries).reduce((a, b) => a + b, 0);
  save.unspentAttributePoints = Math.max(0, bal.attributePointsPerLevel * lv - (spent.strength + spent.dexterity + spent.intelligence + spent.vitality));
  save.unspentMasteryPoints = Math.max(0, bal.masteryPointsPerLevel * lv - usedM);
  save.unspentSkillPoints = Math.max(0, bal.skillPointsPerLevel * lv - Object.values(save.skills).reduce((a, b) => a + b, 0));
  return save;
}
