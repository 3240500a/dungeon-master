import { ConfigRegistry, newBotSave, makePlayerModel, estimateAttack, estimateLearnedSkills, generateMonster, generateItem, createRng, hitChance, armorMitigation, addToInventory, xpForLevel, type SaveState, type EquipSlot, type Rarity, type DerivedStats, type DamageType } from '@dm/shared';
import { makeHarness } from './gameHarness.js';
import type { App } from '@dm/client/core/app.js';
import type { DomUi, Panel } from '@dm/client/ui/domUi.js';
import { characterPanel } from '@dm/client/modules/progression/panels.js';
import { inventoryPanel } from '@dm/client/modules/inventory/inventoryPanel.js';
import { renderPassiveTree } from '@dm/client/modules/skills-passive/treeView.js';
import { renderSkillTree } from '@dm/client/modules/skills/skillTreeView.js';

/**
 * Вкладка «Калькулятор» — планировщик персонажа 1:1 с игрой: реальные панели (стат-лист `characterPanel`,
 * паперкукла+инвентарь `inventoryPanel`, атласы скиллов/мастерства) поверх моста `gameHarness`
 * (App+GameState, команды через townActions). Справа — монстр + TTK (можно выбрать скилл на атаке).
 * Мост/панели ПЕРСИСТЕНТНЫ (пересобираются только при смене класса/уровня), чтобы панели держали
 * своё состояние (буфер атрибутов и т.п.).
 */
function regFromData(data: Record<string, unknown>): ConfigRegistry { const reg = new ConfigRegistry(); reg.loadAll(data); return reg; }

let classId = '';
let level = 30;
let tab: 'char' | 'gear' | 'mastery' | 'skills' = 'char';
let monBaseId = '';
let monChampion = false;
let atkSel = '';               // '' = базовая атака; иначе nodeId выбранного активного скилла
let itemRarity: '' | Rarity = '';
let createBaseId = '';
let rollSeed = 100;
// Персистентный мост + инстанс стат-панели (пересобираются при смене класса/уровня).
let harness: App | null = null;
let hkey = '';
let charInst: Panel | null = null;
let rendering = false;         // анти-реэнтранси: панели/held-item шлют state:changed по ходу рендера

const h = (tag: string, css: string, html = ''): HTMLElement => { const e = document.createElement(tag); e.style.cssText = css; if (html) e.innerHTML = html; return e; };
const pctS = (x: number): string => `${Math.round(x * 100)}%`;
const INP = 'padding:5px 8px;background:#0f0f16;color:#e8e8f0;border:1px solid #2c2c3a;border-radius:4px;font-size:13px';

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
  if (rendering) return;           // state:changed из панелей во время рендера не должен запускать вложенный рендер
  rendering = true;
  try { renderCalcInner(page, data); } finally { rendering = false; }
}

function renderCalcInner(page: HTMLElement, data: Record<string, unknown>): void {
  page.innerHTML = '';
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
    // Инвентарь/паперкукла перерисовываются по шине (взять/положить/дроп без прямого onChange).
    harness.bus.on('state:changed', () => renderCalcPage(page, data));
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

/** Вкладка «Экипировка»: генератор предметов → инвентарь + РЕАЛЬНАЯ паперкукла игры (надеваешь как в игре). */
function gearPanel(app: App, onChange: () => void, reg: ConfigRegistry): HTMLElement {
  const save = app.state!.save;
  const itemsBase = reg.get('items.base');
  const rarities = reg.get('rarities');
  const dims = reg.get('balance').inventory;
  const equippable = itemsBase.filter((b) => !!(b as { slot?: EquipSlot }).slot);
  if (!createBaseId || !equippable.some((b) => b.id === createBaseId)) createBaseId = equippable[0]?.id ?? '';

  const wrap = h('div', 'display:flex;flex-direction:column;gap:10px');

  // ── Генератор предмета → в инвентарь ──
  const strip = h('div', 'border:1px solid #2c2c3a;border-radius:8px;padding:10px;background:#14141c');
  strip.appendChild(h('div', 'font-size:12px;color:#9aa;margin-bottom:6px', `Создать предмет (ур.${level}) → падает в инвентарь, надеть на паперкукле как в игре`));
  const row = h('div', 'display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end');
  const baseSel = document.createElement('select'); baseSel.style.cssText = INP + ';min-width:190px';
  for (const b of equippable) { const o = document.createElement('option'); o.value = b.id; o.textContent = `${b.name} · ${(b as { slot?: string }).slot}`; if (b.id === createBaseId) o.selected = true; baseSel.appendChild(o); }
  baseSel.addEventListener('change', () => { createBaseId = baseSel.value; });
  const rarSel = document.createElement('select'); rarSel.style.cssText = INP;
  for (const [v, t] of [['', 'натур.'], ...rarities.map((r) => [r.id, r.name] as [string, string])] as [string, string][]) { const o = document.createElement('option'); o.value = v; o.textContent = t; if (v === itemRarity) o.selected = true; rarSel.appendChild(o); }
  rarSel.addEventListener('change', () => { itemRarity = rarSel.value as '' | Rarity; });
  const msg = h('div', 'font-size:11px;color:#e0708a;min-height:14px;margin-top:6px');
  const mkBtn = document.createElement('button'); mkBtn.textContent = '＋ создать';
  mkBtn.style.cssText = 'padding:6px 12px;cursor:pointer;background:#3a3a4c;color:#e8e8f0;border:1px solid #4a4a5c;border-radius:5px;font-size:12px';
  mkBtn.addEventListener('click', () => {
    const item = generateItem(itemsBase, reg.get('affixes'), reg.get('uniques'), {
      dropBias: 1, itemLevel: level, baseId: createBaseId, tiers: reg.get('item-tiers'), rarities, rareNames: reg.get('rare-names'),
      categoryWeights: reg.get('balance').loot.categoryWeights, forceRarity: itemRarity || undefined, maxReqTotal: reg.get('balance').maxTotalRequirement,
    }, createRng(rollSeed++));
    if (!addToInventory(save.inventory, item, dims)) { msg.textContent = 'Нет места в инвентаре'; return; }
    onChange();
  });
  row.append(field('База', baseSel), field('Редкость', rarSel), mkBtn);
  strip.append(row, msg);
  wrap.appendChild(strip);

  // ── Реальная паперкукла + сетка инвентаря (equip/moveItem/unequip → townActions через мост) ──
  const dollBox = h('div', 'border:1px solid #2c2c3a;border-radius:8px;padding:12px;background:#14141c');
  inventoryPanel(app, { refresh: onChange } as unknown as DomUi).render(dollBox); // ui не используется (ре-рендер по шине)
  wrap.appendChild(dollBox);
  return wrap;
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

  // Выбор скилла на атаке (иначе базовая атака) — урон берётся из той же оценки, что и симовый бой.
  const learned = estimateLearnedSkills(reg, save, d, m.attrs);
  if (atkSel && !learned.some((l) => l.nodeId === atkSel)) atkSel = '';
  const selSkill = learned.find((l) => l.nodeId === atkSel) ?? null;
  if (learned.length) {
    const atkEl = document.createElement('select'); atkEl.style.cssText = INP + ';min-width:170px';
    for (const [v, t] of [['', 'Базовая атака'], ...learned.map((l) => [l.nodeId, `${l.name} (ур.${l.rank})`] as [string, string])] as [string, string][]) { const o = document.createElement('option'); o.value = v; o.textContent = t; if (v === atkSel) o.selected = true; atkEl.appendChild(o); }
    atkEl.addEventListener('change', () => { atkSel = atkEl.value; renderCalcPage(page, data); });
    monRow.appendChild(field('Атака', atkEl));
  }
  box.appendChild(monRow);

  const mon = generateMonster(mons, reg.get('monster-gear'), reg.get('monster-affixes'), { baseId: monBaseId, depth: level - 1, forceChampion: monChampion, mderive: reg.get('monster-derive') }, createRng(1));
  // Митигация по типу урона атаки: физ — броня, стихии — сопротивление монстра (как в бою).
  const resById: Record<DamageType, number> = { physical: 0, fire: mon.resFire, cold: mon.resCold, lightning: mon.resLightning, poison: mon.resPoison };
  const atkType: DamageType = selSkill ? selSkill.sim.element : (m.weapons[0]?.damageType ?? 'physical');
  const mit = atkType === 'physical' ? armorMitigation(mon.armor, save.level) : resById[atkType];
  const hit = selSkill ? selSkill.sim.magnitude : estimateAttack(m.derived, m.attrs, m.weapons[0], m.scaling, m.weights);
  const pInterval = selSkill && selSkill.sim.cooldown > 0 ? Math.max(selSkill.sim.cooldown, m.attackInterval) : m.attackInterval;
  const pHitCh = hitChance(d.accuracy, mon.evade);
  const pExp = hit * pHitCh * (1 - mon.blockChance) * (1 + d.critChance * (d.critMultiplier - 1)) * (1 - mit);
  const pDps = pExp / pInterval;
  const monAvg = (mon.minDamage + mon.maxDamage) / 2;
  const mHitCh = hitChance(mon.accuracy, d.evade);
  const mExp = monAvg * mHitCh * (1 - d.blockChance) * (1 + mon.critChance * (mon.critMultiplier - 1)) * (1 - armorMitigation(d.armor, mon.level));
  const mDps = mExp * mon.attackSpeed;
  const ttkKill = mon.hp / Math.max(0.01, pDps), ttkDeath = d.maxHp / Math.max(0.01, mDps);
  box.appendChild(statCard(`Монстр: ${mon.name}`, [
    ['HP', `${mon.hp}${mon.hpRegen ? ` (+${mon.hpRegen}/с)` : ''}`], ['Урон / DPS', `${mon.minDamage}–${mon.maxDamage} / ${Math.round(mDps)}`],
    ['Меткость / Уворот / Армор', `${mon.accuracy} / ${mon.evade} / ${mon.armor}`], ['Блок / Крит', `${pctS(mon.blockChance)} / ${pctS(mon.critChance)}`],
    ['Сопр. (о/х/м/я)', `${pctS(mon.resFire)} / ${pctS(mon.resCold)} / ${pctS(mon.resLightning)} / ${pctS(mon.resPoison)}`],
    ['AI / XP', `${mon.ai} / ${mon.xp}`], ['Афиксы', mon.affixes.length ? mon.affixes.join(', ') : '—'],
  ]));
  const win = ttkKill < ttkDeath;
  const ttk = statCard('TTK (время до убийства)', [
    ['Игрок → монстр', `~${ttkKill.toFixed(1)}с · ${Math.ceil(mon.hp / Math.max(0.01, pExp))} уд · поп. ${pctS(pHitCh)}`],
    ['Монстр → игрок', `~${ttkDeath.toFixed(1)}с · ${Math.ceil(d.maxHp / Math.max(0.01, mExp))} уд · поп. ${pctS(mHitCh)}`],
  ]);
  if (selSkill) ttk.appendChild(h('div', 'margin-top:6px;font-size:11px;color:#9aa', `Скилл «${selSkill.name}»: ${dmgShort(reg, selSkill.sim.element)} · ~${Math.round(hit)}/удар · КД ${selSkill.sim.cooldown.toFixed(1)}с · мана ${selSkill.sim.manaCost}${selSkill.sim.aoe ? ' · AoE' : ''}`));
  ttk.appendChild(h('div', `margin-top:8px;font-size:13px;font-weight:600;color:${win ? '#5dcaa5' : '#e0708a'}`, `${win ? '▲ Игрок побеждает' : '▼ Монстр побеждает'} · запас ×${(Math.max(ttkKill, ttkDeath) / Math.max(0.01, Math.min(ttkKill, ttkDeath))).toFixed(1)}`));
  box.appendChild(ttk);
  return box;
}

function dmgShort(reg: ConfigRegistry, dt: DamageType): string {
  return dt === 'physical'
    ? (reg.get('damage-kinds').find((k) => k.id === 'physical')?.short ?? 'физ')
    : (reg.get('magic-subtypes').find((s) => s.id === dt)?.short ?? dt);
}
function field(labelText: string, ctrl: HTMLElement): HTMLElement { const w = h('div', 'display:flex;flex-direction:column;gap:3px'); w.append(h('label', 'font-size:11px;color:#9aa', labelText), ctrl); return w; }
function statCard(title: string, rows: [string, string][]): HTMLElement {
  const box = h('div', 'border:1px solid #2c2c3a;border-radius:8px;padding:12px 14px;background:#14141c');
  box.appendChild(h('div', 'color:#b8b8c8;font-weight:600;font-size:13px;margin-bottom:6px', title));
  for (const [k, v] of rows) { const r = h('div', 'display:flex;justify-content:space-between;gap:12px;font-size:12px;padding:2px 0'); r.append(h('span', 'color:#8a8a9a', k), h('span', 'color:#eaeaea;font-weight:500;text-align:right', v)); box.appendChild(r); }
  return box;
}
