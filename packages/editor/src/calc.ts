import { ConfigRegistry, newBotSave, makePlayerModel, estimateAttack, generateMonster, generateItem, createRng, hitChance, armorMitigation, describeItem, xpForLevel, type SaveState, type EquipSlot, type Rarity, type ItemLabels, type DerivedStats } from '@dm/shared';
import { makeHarness } from './gameHarness.js';
import type { App } from '@dm/client/core/app.js';
import type { DomUi, Panel } from '@dm/client/ui/domUi.js';
import { characterPanel } from '@dm/client/modules/progression/panels.js';
import { renderPassiveTree } from '@dm/client/modules/skills-passive/treeView.js';
import { renderSkillTree } from '@dm/client/modules/skills/skillTreeView.js';

/**
 * Вкладка «Калькулятор» — планировщик персонажа 1:1 с игрой: реальные панели (стат-лист `characterPanel`,
 * атласы скиллов/мастерства) поверх моста `gameHarness` (App+GameState, команды через townActions). Плюс
 * зона монстра + TTK. Мост/панели ПЕРСИСТЕНТНЫ (пересобираются только при смене класса/уровня), чтобы
 * панели держали своё состояние (буфер атрибутов и т.п.). Экипировка — ролл-строка (паперкукла — позже).
 */
function regFromData(data: Record<string, unknown>): ConfigRegistry { const reg = new ConfigRegistry(); reg.loadAll(data); return reg; }

const SLOTS: { s: EquipSlot; ru: string }[] = [
  { s: 'weapon', ru: 'Оружие' }, { s: 'offhand', ru: 'Щит/офф' }, { s: 'helm', ru: 'Шлем' }, { s: 'chest', ru: 'Броня' },
  { s: 'gloves', ru: 'Перчатки' }, { s: 'boots', ru: 'Сапоги' }, { s: 'belt', ru: 'Пояс' }, { s: 'ring', ru: 'Кольцо' }, { s: 'amulet', ru: 'Амулет' },
];

let classId = '';
let level = 30;
let tab: 'char' | 'gear' | 'mastery' | 'skills' = 'char';
let monBaseId = '';
let monChampion = false;
let itemRarity: '' | Rarity = '';
let rollSeed = 100;
// Персистентный мост + инстанс стат-панели (пересобираются при смене класса/уровня).
let harness: App | null = null;
let hkey = '';
let charInst: Panel | null = null;

const h = (tag: string, css: string, html = ''): HTMLElement => { const e = document.createElement(tag); e.style.cssText = css; if (html) e.innerHTML = html; return e; };
const pctS = (x: number): string => `${Math.round(x * 100)}%`;
const INP = 'padding:5px 8px;background:#0f0f16;color:#e8e8f0;border:1px solid #2c2c3a;border-radius:4px;font-size:13px';

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

function freshSave(reg: ConfigRegistry, clsId: string, lvl: number): SaveState {
  const s = newBotSave(reg, clsId);
  s.level = lvl;
  const bal = reg.get('balance'); const n = Math.max(0, lvl - 1);
  s.xp = xpForLevel(lvl, bal.xpTable); // чтобы полоса опыта не была отрицательной
  s.unspentAttributePoints = bal.attributePointsPerLevel * n;
  s.unspentSkillPoints = bal.skillPointsPerLevel * n;
  s.unspentMasteryPoints = bal.masteryPointsPerLevel * n;
  return s;
}

export function renderCalcPage(page: HTMLElement, data: Record<string, unknown>): void {
  page.innerHTML = ''; hideTip();
  const reg = regFromData(data);
  const classes = reg.get('classes');
  if (!classId || !classes.some((c) => c.id === classId)) classId = classes[0]?.id ?? '';
  const cls = classes.find((c) => c.id === classId);
  if (!cls) { page.appendChild(h('div', 'color:#9aa', 'Нет классов в конфиге.')); return; }

  // Пересобираем мост/панели только при смене класса/уровня — иначе панели теряют своё состояние.
  const key = `${classId}|${level}`;
  if (key !== hkey || !harness) {
    const save = freshSave(reg, classId, level);
    harness = makeHarness(data, save, () => renderCalcPage(page, data));
    const uiStub = { refresh: () => renderCalcPage(page, data) } as unknown as DomUi;
    charInst = characterPanel(harness, uiStub);
    hkey = key;
  }
  const app = harness;

  page.appendChild(h('div', 'font-size:15px;font-weight:600;color:#e8e8f0;margin:2px 0 10px', '🧮 Калькулятор персонажа (1:1 с игрой)'));
  const wrap = h('div', 'display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start');
  const left = h('div', 'flex:1 1 560px;min-width:320px;display:flex;flex-direction:column;gap:10px');
  const right = h('div', 'flex:0 1 380px;min-width:300px;display:flex;flex-direction:column;gap:12px');
  wrap.append(left, right); page.appendChild(wrap);

  const head = h('div', 'display:flex;gap:10px;align-items:flex-end');
  const classSel = document.createElement('select'); classSel.style.cssText = INP;
  for (const c of classes) { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; if (c.id === classId) o.selected = true; classSel.appendChild(o); }
  classSel.addEventListener('change', () => { classId = classSel.value; harness = null; renderCalcPage(page, data); });
  const lvlInp = document.createElement('input'); lvlInp.type = 'number'; lvlInp.min = '1'; lvlInp.max = '99'; lvlInp.value = String(level); lvlInp.style.cssText = INP + ';width:64px';
  lvlInp.addEventListener('change', () => { level = Math.max(1, Math.min(99, Number(lvlInp.value) || 1)); harness = null; renderCalcPage(page, data); });
  head.append(field('Класс', classSel), field('Уровень', lvlInp));
  left.appendChild(head);

  const tabs = h('div', 'display:flex;gap:4px');
  for (const [id, name] of [['char', 'Персонаж'], ['gear', 'Экипировка'], ['mastery', 'Мастерство'], ['skills', 'Скиллы']] as [typeof tab, string][]) {
    const b = document.createElement('button'); b.textContent = name;
    b.style.cssText = `flex:1;padding:6px 4px;cursor:pointer;border-radius:5px;border:1px solid #2c2c3a;background:${tab === id ? '#3a3a4c' : '#1c1c26'};color:#e8e8f0;font-size:12px`;
    b.addEventListener('click', () => { tab = id; renderCalcPage(page, data); });
    tabs.appendChild(b);
  }
  left.appendChild(tabs);

  const body = h('div', '');
  if (tab === 'char') charInst!.render(body);
  else if (tab === 'gear') left.appendChild(gearPanel(app, () => renderCalcPage(page, data), reg));
  else if (tab === 'mastery') { const box = h('div', 'border:1px solid #2c2c3a;border-radius:8px;background:#0e0e15;height:520px;overflow:hidden'); renderPassiveTree(app, box); left.appendChild(box); }
  else { const box = h('div', 'border:1px solid #2c2c3a;border-radius:8px;background:#0e0e15;height:520px;overflow:hidden'); renderSkillTree(app, box); left.appendChild(box); }
  if (tab === 'char') left.appendChild(body);

  right.appendChild(monsterTtk(page, data, reg, app.state!.derived(), makePlayerModel(reg, app.state!.save, { useSkills: true }), app.state!.save));
}

function gearPanel(app: App, onChange: () => void, reg: ConfigRegistry): HTMLElement {
  const save = app.state!.save;
  const itemsBase = reg.get('items.base');
  const rarities = reg.get('rarities');
  const R = itemLabels(reg);
  const rarCol = (id: string): string => rarities.find((r) => r.id === id)?.color ?? '#c8c8c8';
  const rollFor = (slot: EquipSlot, baseId: string): void => {
    save.equipment[slot] = generateItem(itemsBase, reg.get('affixes'), reg.get('uniques'), {
      dropBias: 1, itemLevel: level, baseId, tiers: reg.get('item-tiers'), rarities, rareNames: reg.get('rare-names'),
      categoryWeights: reg.get('balance').loot.categoryWeights, forceRarity: itemRarity || undefined, maxReqTotal: reg.get('balance').maxTotalRequirement,
    }, createRng(rollSeed++));
  };
  const box = h('div', 'border:1px solid #2c2c3a;border-radius:8px;padding:10px;background:#14141c');
  const headRow = h('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px');
  headRow.appendChild(h('div', 'font-size:12px;color:#9aa', 'Экипировка (создать/надеть; наведи = статы). Паперкукла — позже.'));
  const rarSel = document.createElement('select'); rarSel.style.cssText = INP + ';font-size:11px;padding:2px 6px';
  for (const [v, t] of [['', 'натур.'], ...rarities.map((r) => [r.id, r.name] as [string, string])] as [string, string][]) { const o = document.createElement('option'); o.value = v; o.textContent = t; if (v === itemRarity) o.selected = true; rarSel.appendChild(o); }
  rarSel.addEventListener('change', () => { itemRarity = rarSel.value as '' | Rarity; onChange(); });
  headRow.appendChild(rarSel); box.appendChild(headRow);

  for (const { s, ru } of SLOTS) {
    const bases = itemsBase.filter((b) => (b as { slot?: EquipSlot }).slot === s);
    if (!bases.length) continue;
    const cur = save.equipment[s];
    const row = h('div', 'display:flex;align-items:center;gap:5px;margin:3px 0');
    row.appendChild(h('span', 'width:64px;font-size:11px;color:#9aa', ru));
    const sel = document.createElement('select'); sel.style.cssText = INP + ';flex:1;font-size:12px;padding:3px 6px';
    const e0 = document.createElement('option'); e0.value = ''; e0.textContent = '— пусто —'; sel.appendChild(e0);
    for (const b of bases) { const o = document.createElement('option'); o.value = b.id; o.textContent = b.name; if (cur?.baseId === b.id) o.selected = true; sel.appendChild(o); }
    sel.addEventListener('change', () => { if (!sel.value) delete save.equipment[s]; else rollFor(s, sel.value); onChange(); });
    row.appendChild(sel);
    const rr = miniBtn('↻', () => { if (cur?.baseId) { rollFor(s, cur.baseId); onChange(); } }); rr.title = 'Перекатать';
    if (!cur) rr.style.opacity = '0.4';
    row.appendChild(rr); box.appendChild(row);
    if (cur) {
      const nameEl = h('div', `font-size:11px;color:${rarCol(cur.rarity)};margin:0 0 4px 68px;cursor:help`, cur.name);
      const tip = (): string => `<div style="color:${rarCol(cur.rarity)};font-weight:600;margin-bottom:4px">${cur.name}</div>` + describeItem(cur, R).map((l) => `<div style="color:${l.affix ? rarCol(cur.rarity) : '#dcdce4'}">${l.text}</div>`).join('');
      nameEl.addEventListener('mousemove', (e) => showTip(tip(), (e as MouseEvent).clientX, (e as MouseEvent).clientY));
      nameEl.addEventListener('mouseleave', hideTip);
      box.appendChild(nameEl);
    }
  }
  return box;
}

function monsterTtk(page: HTMLElement, data: Record<string, unknown>, reg: ConfigRegistry, d: DerivedStats, m: ReturnType<typeof makePlayerModel>, save: SaveState): HTMLElement {
  const box = h('div', 'display:flex;flex-direction:column;gap:12px');
  const mons = reg.get('monsters');
  if (!monBaseId || !mons.some((mm) => mm.id === monBaseId)) monBaseId = mons[0]?.id ?? '';
  if (!mons.length) return box;
  const monRow = h('div', 'display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap');
  const monSel = document.createElement('select'); monSel.style.cssText = INP + ';min-width:170px';
  for (const mm of mons) { const o = document.createElement('option'); o.value = mm.id; o.textContent = `${mm.name} [${mm.tier}]`; if (mm.id === monBaseId) o.selected = true; monSel.appendChild(o); }
  monSel.addEventListener('change', () => { monBaseId = monSel.value; renderCalcPage(page, data); });
  const champWrap = h('label', 'display:flex;align-items:center;gap:5px;font-size:13px;color:#e8e8f0;cursor:pointer');
  const champInp = document.createElement('input'); champInp.type = 'checkbox'; champInp.checked = monChampion;
  champInp.addEventListener('change', () => { monChampion = champInp.checked; renderCalcPage(page, data); });
  champWrap.append(champInp, document.createTextNode('чемпион'));
  monRow.append(field(`Монстр (ур.${level})`, monSel), field(' ', champWrap));
  box.appendChild(monRow);

  const hit = estimateAttack(m.derived, m.attrs, m.weapons[0], m.scaling, m.weights);
  const mon = generateMonster(mons, reg.get('monster-gear'), reg.get('monster-affixes'), { baseId: monBaseId, depth: level - 1, forceChampion: monChampion, mderive: reg.get('monster-derive') }, createRng(1));
  const pHitCh = hitChance(d.accuracy, mon.evade);
  const pExp = hit * pHitCh * (1 - mon.blockChance) * (1 + d.critChance * (d.critMultiplier - 1)) * (1 - armorMitigation(mon.armor, save.level));
  const pDps = pExp / m.attackInterval;
  const monAvg = (mon.minDamage + mon.maxDamage) / 2;
  const mHitCh = hitChance(mon.accuracy, d.evade);
  const mExp = monAvg * mHitCh * (1 - d.blockChance) * (1 + mon.critChance * (mon.critMultiplier - 1)) * (1 - armorMitigation(d.armor, mon.level));
  const mDps = mExp * mon.attackSpeed;
  const ttkKill = mon.hp / Math.max(0.01, pDps), ttkDeath = d.maxHp / Math.max(0.01, mDps);
  box.appendChild(statCard(`Монстр: ${mon.name}`, [
    ['HP', `${mon.hp}${mon.hpRegen ? ` (+${mon.hpRegen}/с)` : ''}`], ['Урон / DPS', `${mon.minDamage}–${mon.maxDamage} / ${Math.round(mDps)}`],
    ['Меткость / Уворот / Армор', `${mon.accuracy} / ${mon.evade} / ${mon.armor}`], ['Блок / Крит', `${pctS(mon.blockChance)} / ${pctS(mon.critChance)}`],
    ['AI / XP', `${mon.ai} / ${mon.xp}`], ['Афиксы', mon.affixes.length ? mon.affixes.join(', ') : '—'],
  ]));
  const win = ttkKill < ttkDeath;
  const ttk = statCard('TTK (время до убийства)', [
    ['Игрок → монстр', `~${ttkKill.toFixed(1)}с · ${Math.ceil(mon.hp / Math.max(0.01, pExp))} уд · поп. ${pctS(pHitCh)}`],
    ['Монстр → игрок', `~${ttkDeath.toFixed(1)}с · ${Math.ceil(d.maxHp / Math.max(0.01, mExp))} уд · поп. ${pctS(mHitCh)}`],
  ]);
  ttk.appendChild(h('div', `margin-top:8px;font-size:13px;font-weight:600;color:${win ? '#5dcaa5' : '#e0708a'}`, `${win ? '▲ Игрок побеждает' : '▼ Монстр побеждает'} · запас ×${(Math.max(ttkKill, ttkDeath) / Math.max(0.01, Math.min(ttkKill, ttkDeath))).toFixed(1)}`));
  box.appendChild(ttk);
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
