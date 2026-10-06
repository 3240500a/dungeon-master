/**
 * ПРОДЮСЕР И СТОРОЖ эталона ОКНА КОВКИ для Unity-клиента (U6c): ядро ковки из деталей (`craftWeapon` целиком — детали с отказами,
 * тип и историческое имя, ступень из материалов, ворота журнала, запекание гнёзд, цена с доводкой, вещь-предпросмотр с вилкой урона и
 * требованиями), окно поверх него (`craftPanel.ts`: классы и семейства, ключевые формы по базам, строки деталей с замками и эскизами,
 * материал в окне формы, подписи и эффекты, доводка, строки цены против кошелька, «Ковать» с причиной, зачарование скованной), хозяин
 * окна (`craftHost.ts`: подпись заявки, заявка на провод), тултип вещи (`describeItem` — им окно показывает предпросмотр), подпись вида
 * оружия (`weaponLookSig`) и базовый хват оружия в кулаке (`pe_grip`, `loadGrip` веб-рантайма).
 *
 * Unity — основной клиент, веб — источник истины по правилам. Настоящими функциями веба считаются экспортированные (`@dm/shared`,
 * `craftPanel.ts`: `forgeableFamilies`, `initialCraftState`, `normalizeCraftState`; `craftHost.ts`: `craftSig`, `wireInput`). Разметка окна
 * живёт в замыкании `craftWindow`, подписи — в функциях модуля (`partEffect`, `baseLine`, `sketchElsewhere`, `rollVerdict`…), резолверы
 * тултипа — в `app.ts`, хват — в `poseRuntime.ts`/`weapon3d.ts`: здесь они повторены копией, и каждая копия СТОРОЖИТСЯ строкой исходника
 * (`SRC`) — правило поменяли, тест падает, пока копию, эталон и порт Unity не обновят.
 *
 * Эталон: `__golden__/unity_craft.json` → Unity `Assets/DM/UI/Tests/unity_craft_golden.json` (`tools/unity-check/golden_sync.py`),
 * проверка — `CraftCheck`. Перезапись: `npx vitest run packages/client/src/modules/town/unityCraftGolden.gen.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CRAFT_SLOT_LIST, CRAFT_SLOT_ROLE, ConfigRegistry, ESSENCE_ID, FORM_UNPRICED, anatomyOf, axisOf, balanceAxisOf, baseOfKeyPart, baseTierRange, bladeCaption, buildCraftShell,
  bladeStats, clampStep, craftFits, craftMissing, craftTiers, craftWeapon, createRng, debuffLabel, defaultParts, describeCost, describeItem,
  emptyJournal, enchantCost, enchantItem, enchantMaterials, enchantSlots, familiesOf, finishOf, fullJournal, generateItem, itemFromBaseId, keySlotOf,
  keyVariantsByBase, materialItem, partById, rangeLabel, rolledFormMult, sketchable, slotName, slotSuffix, statusKindOf, stepLabel,
  tierOfSteps, variantsFor, weaponLookSig,
  type CraftInput, type CraftJournal, type CraftParts, type CraftSlot, type Item, type ItemLabels, type Rarity, type WeaponPart,
} from '@dm/shared';
import { forgeableFamilies, initialCraftState, normalizeCraftState, type CraftWindowState } from './craftPanel.js';
import { craftSig, wireInput, CRAFT_UNKNOWN } from './craftHost.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(HERE, rel), 'utf8');
const PANEL = read('./craftPanel.ts');
const HOST = read('./craftHost.ts');
const TAB = read('./forgeCraftTab.ts');
const FORGE = read('./forgePanel.ts');
const APP = read('../../core/app.ts');
const DMG = read('../../core/damageTypes.ts');
const RUNTIME = read('../../render3d/poseRuntime.ts');
const LAYERS = read('../../render3d/poseLayers.ts');
const WEAPON3D = read('../../render3d/weapon3d.ts');

/** Строки исходников, повторённые ниже копией. Нет строки — правило веба поменялось: обновить копию, эталон и порт Unity. */
const SRC: [string, string][] = [
  // окно ковки (craftPanel.ts)
  [PANEL, "const RARITY_DOT: Record<string, string> = { common: COLORS.dim, uncommon: COLORS.info, rare: COLORS.gold };"],
  [PANEL, "const RARITY_NAME: Record<string, string> = { common: 'обычная', uncommon: 'нечастая', rare: 'редкая' };"],
  [PANEL, "const ORDER = ['sword', 'dagger', 'axe', 'mace', 'spear', 'halberd', 'bow', 'crossbow', 'wand', 'staff'];"],
  [PANEL, 'const pct = (x: number, d = 0): string => `${(x * 100).toFixed(d)} %`;'],
  [PANEL, 'const fx = (x: number, d = 1): string => x.toFixed(d);'],
  [PANEL, "const signed = (x: number, unit = '', d = 0): string => `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(x).toFixed(d)}${unit}`;"],
  [PANEL, "const IDLE_CLASS = 'Кузнец сейчас не куёт этот класс';"],
  [PANEL, "const IDLE_FAMILY = 'Кузнец сейчас не куёт это семейство';"],
  [PANEL, "if (defaultParts(reg, weaponClass, hands, 2)) return '';"],
  [PANEL, 'return forgeableFamilies(reg, weaponClass).length ? IDLE_FAMILY : IDLE_CLASS;'],
  [PANEL, "const mn = item.baseStats.find((m) => m.stat === 'minDamage' && m.kind === 'flat')?.value;"],
  [PANEL, 'const k = item.damageMult ?? 1, r = (v: number): number => Math.round(v * k);'],
  [PANEL, 'const q = item.baseRoll ? ((item.baseRoll.minDamage ?? 0.5) + (item.baseRoll.maxDamage ?? 0.5)) / 2 : 0.5;'],
  [PANEL, 'const pos = floor >= 1 ? 100 : Math.round((Math.max(0, q - floor) / (1 - floor)) * 100);'],
  [PANEL, 'return ` · урон ${r(mn)}–${r(mx)} из вилки ${rangeLabel(ranges.minDamage, k)}–${rangeLabel(ranges.maxDamage, k)} · бросок ${pos} % вилки`;'],
  [PANEL, "const FORM_NAME: Record<string, string> = { falchion: 'фальшион', sabre: 'сабля' };"],
  [PANEL, "const axisLabel = (x: number): string => `${x > 0 ? '+' : ''}${Math.round(x * 100) / 100}`;"],
  [PANEL, 'return b ? bladeCaption(b) : p.caption;'],
  [PANEL, "`клинок ${g.len} см${br ? ` · вилка «${br.name}» ${br.lo}–${br.hi} см` : ' · вне вилок'}${b.outOfBracket && br ? ' (вне вилки — ось в упоре)' : ''} → место ${signed(b.place, '', 2)}, ось ${signed(b.axis, '', 2)}`,"],
  [PANEL, "`ширина ${g.width} см${br ? ` (эталон ${br.width})` : ''} → разброс ×${fx(b.spread, 2)}`,"],
  [PANEL, '`центр тяжести ${pct(g.bal)} длины → баланс клинка ${signed(b.balance, \'\', 2)}`,'],
  [PANEL, "fk && b.form ? `${FORM_NAME[b.form]}: длина ${signed(fk.length, '', 2)}, баланс ${signed(fk.balance, '', 2)}` : '',"],
  [PANEL, "const out = [`урон ×${fx(1 + k.strike.damagePct * axis, 2)}`, `скорость ×${fx(1 - k.strike.attackSpeed * axis, 2)}`];"],
  [PANEL, 'if (b) out.push(`разброс ×${fx(b.spread, 2)}`);'],
  [PANEL, "return ['bow', 'crossbow', 'wand', 'staff'].includes(weaponClass) ? 'только вид (§5.2)' : `дальность ×${fx(r, 2)} · дуга ×${fx(a, 2)}`;"],
  [PANEL, "if (slot === 'bind') return axis > 0 ? 'больше префиксов' : axis < 0 ? 'больше суффиксов' : 'поровну';"],
  [PANEL, "const lead = strike && bladeStats(reg, strike) ? `баланс ${signed(bal, '', 2)}: ` : '';"],
  [PANEL, "const own = base?.baseStats.filter((m) => m.stat === 'blockChance' && m.kind === 'flat').reduce((s, m) => s + m.value, 0) ?? 0;"],
  [PANEL, "const floor = weaponClass === 'bow' ? (bal < 0 ? ' (в ноль)' : '') : base && own + k.headBlock * bal < 0 ? ` (у базы ${fx(own * 100, 0)} % — в ноль)` : '';"],
  [PANEL, "const brace = (weaponClass === 'bow' ? `стойкость ${signed(k.headInterrupt * bal * 100, ' п.п.', 1)}` : `блок ${signed(k.headBlock * bal * 100, ' п.п.', 1)}`) + floor;"],
  [PANEL, "const kind = base?.kind === 'weapon' ? statusKindOf(reg, base) : undefined;"],
  [PANEL, 'if (base && !(kind && k.bite[kind])) return `${lead}${brace}`;'],
  [PANEL, "const name = kind ? reg.get('debuffs').find((d) => d.id === kind)?.name.toLowerCase() ?? kind : 'статус';"],
  [PANEL, "return `${lead}${brace} · ${name} ${bal < 0 ? 'чаще' : bal > 0 ? 'реже' : 'как есть'}`;"],
  [PANEL, "if (p.slot !== keySlotOf(reg, weaponClass)) return '';"],
  [PANEL, "if (p.slot !== keySlotOf(reg, cls)) { where.add(reg.get('weapon-anatomy').find((a) => a.id === cls)?.name ?? cls); continue; }"],
  [PANEL, "if (b && j.bases.includes(b)) where.add(`«${reg.get('items.base').find((x) => x.id === b)?.name ?? b}»`);"],
  [PANEL, "return [...where].join(', ');"],
  [PANEL, "const edge = base.physSub ? reg.get('phys-subtypes').find((p) => p.id === base.physSub)?.name.toLowerCase() : reg.get('magic-subtypes').find((m) => m.id === base.damageType)?.name?.toLowerCase();"],
  [PANEL, "const dmg = flat('minDamage') !== undefined ? `${flat('minDamage')}–${flat('maxDamage')}` : '';"],
  [PANEL, "return [base.name, dmg, base.hands === 2 ? 'двуручное' : 'одноручное', edge ?? 'без грани', w ? `вес: ${w.name.toLowerCase()}` : ''].filter(Boolean).join(' · ');"],
  [PANEL, "const matName = (id: string): string => mats.find((m) => m.id === id)?.name ?? id;"],
  [PANEL, "const matOn = (id: string): boolean => host.allowDisabledMaterials || mats.find((m) => m.id === id)?.enabled !== false;"],
  [PANEL, 'const sketches = host.sketch ? j.sketches : 0;'],
  [PANEL, 'if (st.sketchPick && (sketches <= 0 || !sketchable(reg, j, st.sketchPick))) st.sketchPick = undefined;'],
  [PANEL, 'for (const a of [...reg.get(\'weapon-anatomy\')].sort((x, y) => ORDER.indexOf(x.id) - ORDER.indexOf(y.id))) {'],
  [PANEL, 'const idle = !forgeableFamilies(reg, a.id).length;'],
  [PANEL, "const b = mk('button', chip(h === st.hands, busy), h === 2 ? 'Двуручное' : 'Одноручное');"],
  [PANEL, "if (!defaultParts(reg, st.weaponClass, h, 2)) { b.style.borderStyle = 'dashed'; b.title = IDLE_FAMILY; }   // V-B3-06"],
  [PANEL, "root.append(mk('div', `color:${COLORS.dim};font-size:11.5px;margin-bottom:10px`, fams[0] === 2 ? 'Семейство одно: двуручное' : 'Семейство одно: одноручное'));"],
  [PANEL, 'const input: CraftInput = { weaponClass: st.weaponClass, hands: st.hands, parts: structuredClone(st.parts), finish: st.finish ?? 0 };'],
  [PANEL, 'const pv = craftWeapon(reg, input, { journal: j, materialsOn: !host.allowDisabledMaterials });'],
  // ⭐ D3 (06.10): ворот ступени у ковки нет — новое окно всегда на эталонной ст. 2, журнал на неё не влияет (прежний `journalDefaultStep`
  // прижимал её к потолку журнала); кнопки класса и семейства открывают окно без журнала
  [PANEL, "return { weaponClass, hands: h, parts: defaultParts(reg, weaponClass, h, 2) ?? blankParts(), crafted: null, message: '' };"],
  [PANEL, 'Object.assign(st, initialCraftState(reg, a.id)); draw();'],
  [PANEL, 'Object.assign(st, initialCraftState(reg, st.weaponClass, h)); draw();'],
  [PANEL, 'const why = idle || pv.reason;'],
  [PANEL, "type?.ok ? type.name : '—'"],
  [PANEL, '`${tiers[tier]?.id} ${tiers[tier]?.name}`'],
  [PANEL, "tierBox.title = `Средний уровень материала по массе: Q = (${w.strike}·${st.parts.strike.step} + ${st.parts.grip.step} + ${st.parts.bind.step} + ${st.parts.head.step}) / ${w.strike + w.grip + w.bind + w.head} = ${q}`;"],
  [PANEL, "`Q = ${fx(q, 2)}`"],
  [PANEL, "head.append(mk('div', `font-size:11.5px;color:${COLORS.dim};margin-top:2px`, `механика: ${baseLine(reg, type.baseId)}`));"],
  [PANEL, "if (!pv.ok && why) head.append(mk('div', `font-size:12px;color:${COLORS.bad};margin-top:6px`, `⚠ ${why}`));"],
  [PANEL, "box.append(mk('div', '', `✦ Эскизов: ${sketches} — открой закрытую деталь на выбор: нажми на неё в списке (✦). Ключевую форму неоткрытого типа эскиз не открывает — тип открывает разбор.`));"],
  [PANEL, "box.append(mk('div', 'margin-bottom:6px', `✦ Открыть «${pick.name}» эскизом? Эскизов останется ${sketches - 1} — вернуть эскиз нельзя.`"],
  [PANEL, "+ (where ? ` Здесь её тип ещё закрыт (его открывает разбор) — ковать её можно: ${where}.` : '')));"],
  [PANEL, "confirm.append(button(st.busy === 'sketch' ? '⏳ открываю…' : '✦ Открыть эскизом', () => act('sketch', () => host.sketch!(pick.id), (r) => {"],
  [PANEL, "st.message = r.ok ? `Открыто эскизом: ${pick.name}` : r.unknown ? r.reason ?? 'Нет ответа от кузнеца' : `Не вышло: ${r.reason}`;"],
  [PANEL, "const b = mk('button', chip(CRAFT_SLOT_LIST.every((s) => st.parts[s].step === k), busy), `ст. ${k} · ${matName(`${anat[keySlot].family}-${k}`)}`);"],
  [PANEL, "b.title = 'Каждой детали — эта ступень, прижатая к окну её формы';"],
  [PANEL, 'const order: CraftSlot[] = [keySlot, ...CRAFT_SLOT_LIST.filter((s) => s !== keySlot)];'],
  [PANEL, "title.append(mk('div', `font-family:${FONT_TITLE};color:${COLORS.accent};font-size:14px`, anat ? slotName(anat, slot, st.hands) : slot));"],
  [PANEL, "if (isKey) title.append(mk('span', `font-size:10.5px;color:${COLORS.gold};border:1px solid ${COLORS.gold};border-radius:3px;padding:0 4px`, 'определяет тип'));"],
  [PANEL, 'const known = j.variants.includes(p.id);'],
  [PANEL, 'const open = known && baseOpen;'],
  [PANEL, 'const bySketch = !known && sketches > 0 && sketchable(reg, j, p.id);'],
  [PANEL, "const elsewhere = bySketch && !baseOpen ? sketchElsewhere(reg, j, p, st.weaponClass, st.hands) : '';"],
  [PANEL, 'const on = p.id === st.parts[slot].id || (bySketch && st.sketchPick === p.id);'],
  [PANEL, "`<span style=\"flex:1\">${open ? '' : bySketch ? '✦ ' : '🔒 '}${p.name}</span>` +"],
  [PANEL, '`<span style="font-size:10px;color:${COLORS.dim};font-family:monospace">ст.${p.stepMin}–${p.stepMax}</span>` +'],
  [PANEL, '`<span style="font-size:10px;color:${COLORS.dim};font-family:monospace;width:34px;text-align:right">${axisLabel(axisOf(reg, p))}</span>`;'],
  [PANEL, 'b.title = [partCaption(reg, p), p.lore, bladeMeasureLine(reg, p), `${RARITY_NAME[p.rarity]} · материал: ступени ${p.stepMin}–${p.stepMax}`,'],
  [PANEL, "bySketch ? `✦ Открыть эскизом (эскизов: ${sketches})` : '',"],
  [PANEL, "elsewhere ? `Здесь её тип ещё закрыт (его открывает разбор) — ковать её можно: ${elsewhere}` : ''].filter(Boolean).join('\\n');"],
  [PANEL, 'b.disabled = (!open && !bySketch) || busy;'],
  [PANEL, 'const baseOpen = j.bases.includes(g.baseId);'],
  [PANEL, 'const hr = b ? baseTierRange(reg, b) : { lo: 0, hi: 6 };'],
  [PANEL, "const cap = hr.hi < tiers.length - 1 ? ` · до ${tiers[hr.hi]?.id}` : '';"],
  [PANEL, '`${baseOpen ? \'\' : \'🔒 \'}${baseLine(reg, g.baseId)}${cap}`'],
  [PANEL, 'const inWin = k >= sel.stepMin && k <= sel.stepMax;'],
  [PANEL, 'const id = `${sel.family || anat[slot].family}-${k}`;'],
  [PANEL, "b.title = inWin ? `${matName(id)} (${id})${matOn(id) ? '' : ' — ещё нет в игре'}` : `«${sel.name}» из этого не куётся: только ступени ${sel.stepMin}–${sel.stepMax}`;"],
  [PANEL, "if (inWin && !matOn(id)) b.style.borderStyle = 'dashed';"],
  [PANEL, "`Материал · ${anat[slot].stepNames.length && !sel.family ? 'обработка' : matName(`${sel.family || anat[slot].family}-${st.parts[slot].step}`)}`"],
  [PANEL, "eff.title = `Точка баланса вещи: ${Math.round(bk.bladeShare * 100)} % — клинок, ${Math.round((1 - bk.bladeShare) * 100)} % — оголовье (+ поправка формы), в ±1.\\nВес у руки — упор (блок), вес к концу — укус (статус грани).`;"],
  [PANEL, 'const shown = st.crafted ?? pv.item;'],
  [PANEL, "if (shown.affixCap) left.append(mk('div', `margin-top:6px;font-size:12px;color:${COLORS.info}`, `Ёмкость: ${shown.affixCap.prefix} преф. + ${shown.affixCap.suffix} суф. — примет при зачаровании`));"],
  [PANEL, "left.append(mk('div', `color:${COLORS.bad}`, why || 'Не собирается'));"],
  [PANEL, "for (const n of pv.bake?.notes ?? []) left.append(mk('div', `margin-top:6px;font-size:11.5px;color:${COLORS.gold}`, `⚠ ${n}`));"],
  [PANEL, 'if (finishes.length > 1 && pv.cost && anat) {'],
  [PANEL, "fin.append(mk('div', `font-size:11px;color:${COLORS.dim};margin-bottom:4px`, `Доводка: ${slotName(anat, 'strike', st.hands)} — поднимает нижнюю границу урона, верх вилки не растёт`));"],
  [PANEL, "const extra = f.strikeUnits <= 0 && f.goldMult === 1 ? 'без надбавки' : `+${f.strikeUnits} ${strikeMat ? matName(strikeMat.id) : ''} · золото ×${fx(f.goldMult, 2)}`;"],
  [PANEL, 'b.title = `${extra}\\nНиже ${Math.round(f.floor * 100)} % вилки урон не выпадет`;'],
  [PANEL, "costBox.append(mk('div', `font-size:11px;color:${COLORS.dim};margin-bottom:4px`, `Цена: каждая деталь своим материалом (форма ×${fx(pv.cost.mult, 2)})`));"],
  [PANEL, "costBox.append(mk('div', `font-size:12px;color:${have >= need ? COLORS.text : COLORS.bad}`, `${slotName(anat, l.slot, st.hands)}: ${matName(l.id)} — ${l.n}  (есть ${have})`));"],
  [PANEL, 'if (fc && fc.n > 0) {'],
  [PANEL, "costBox.append(mk('div', `font-size:12px;color:${have >= need ? COLORS.text : COLORS.bad}`, `${fc.name}: ${matName(fc.id)} — ${fc.n}  (всего ${need}, есть ${have})`));"],
  [PANEL, "costBox.append(mk('div', `font-size:12px;color:${host.gold() >= pv.cost.gold ? COLORS.gold : COLORS.bad}`, `Золото — ${pv.cost.gold}  (есть ${host.gold()})`));"],
  [PANEL, "? r.item ? `Скована: ${r.item.name}${rollVerdict(r.item, verdict.ranges, verdict.cost?.finish?.floor ?? 0)}` : r.reason ?? 'Скована'"],
  [PANEL, ": r.unknown ? r.reason ?? 'Нет ответа от кузнеца' : `Не вышло: ${r.reason}`;"],
  [PANEL, 'const lack = pv.cost ? craftMissing(host.wallet(), host.gold(), pv.cost) : null;'],
  [PANEL, 'const short = lack ? [...(Object.keys(lack.materials).length ? [describeCost(reg, lack.materials)] : []), ...(lack.gold > 0 ? [`${lack.gold} золота`] : [])] : [];'],
  [PANEL, 'const noRoom = pv.ok && !short.length && !!pv.item && !!pv.cost && !!bag && !craftFits(reg, bag, pv.cost.materials, pv.item);'],
  [PANEL, "const craftBtn = button(st.busy === 'craft' ? '⏳ куём…' : '🔨 Ковать', doCraft, 'primary', !pv.ok || busy || short.length > 0 || noRoom);"],
  [PANEL, 'if (!pv.ok && why) craftBtn.title = why;'],
  [PANEL, "else if (short.length) craftBtn.title = `Не хватает: ${short.join(' · ')}`;"],
  [PANEL, "else if (noRoom) craftBtn.title = 'Нет места в сумке';"],
  [PANEL, "const why = item.rarity !== 'normal' ? 'Вещь уже зачарована'"],
  [PANEL, ": !craftedInBag ? 'Надетую не зачаровать: сперва сними её в сумку'"],
  [PANEL, ": item.broken ? 'Сперва почини'"],
  [PANEL, ": !fit ? 'Кузнец не знает такой вещи'"],
  [PANEL, ": Math.min(fit.slots.maxAffixes, fit.slots.maxPrefix + fit.slots.maxSuffix) <= 0 ? 'Этой вещи некуда принять свойства'"],
  [PANEL, ": !fit.fillable ? 'Кузнецу не хватит свойств на форму этой вещи'"],
  [PANEL, ': rolledFormMult(reg, item, r) === undefined ? FORM_UNPRICED   // R17-03: у катаемой формы нет цены — сервер откажет'],
  // ⭐ §6.2: зачарование тратит и эссенцию — строка нехватки после золота, количество в подписи кнопки, согласие `maxMaterials` хозяину
  [PANEL, 'const ess = enchantMaterials(reg, item, r);'],
  [PANEL, 'const essLack = Object.fromEntries(Object.entries(ess).filter(([id, n]) => (host.wallet()[id] ?? 0) < n).map(([id, n]) => [id, n - (host.wallet()[id] ?? 0)]));'],
  [PANEL, ": host.gold() < cost ? `Недостаточно золота: нужно ${cost}`"],
  [PANEL, ": Object.keys(essLack).length ? `Не хватает материалов: ${describeCost(reg, essLack)}` : '';"],
  [PANEL, 'const essN = Object.values(ess)[0] ?? 0;'],
  [PANEL, "const essHave = host.wallet()[Object.keys(ess)[0] ?? ''] ?? 0;"],
  [PANEL, "const label = st.busy === 'enchant' ? '⏳ зачаровываю…' : `✦ ${r === 'magic' ? 'Магический' : 'Редкий'}${essN > 0 ? ` · эссенция ${essN} (есть ${essHave})` : ''}${Number.isFinite(cost) ? ` · ${cost} з.` : ''}`;"],
  [PANEL, "const b = button(label, () => act('enchant', () => host.enchant(item, r, cost, ess), (res) => {"],
  [PANEL, "st.message = res.ok ? `Зачарована: ${res.item?.name ?? item.name}` : res.unknown ? res.reason ?? 'Нет ответа от кузнеца' : `Не вышло: ${res.reason}`;"],
  [PANEL, "btns.append(button(st.busy === 'equip' ? '⏳ надеваю…' : 'Надеть', () => act('equip', () => host.equip!(item), (res) => {"],
  [PANEL, "st.message = res.ok ? 'Надето' : res.unknown ? res.reason ?? 'Нет ответа' : `Не вышло: ${res.reason}`;"],
  [PANEL, "btns.append(button('Новая заготовка', () => { reset(); draw(); }, 'default', busy));"],
  [PANEL, "if (st.message) left.append(mk('div', `margin-top:6px;font-size:12px;color:${st.message.startsWith('Не') ? COLORS.bad : COLORS.good}`, st.message));"],
  // хозяин окна (craftHost.ts)
  [HOST, 'export const CRAFT_OPEN_KEEP = 8;'],
  [HOST, "const ENCHANT_UNKNOWN = 'Нет ответа от кузнеца. Посмотри вещь в сумке: если она уже зачарована, повтор ничего не спишет';"],
  [HOST, "const SKETCH_UNKNOWN = 'Нет ответа от кузнеца. Посмотри список деталей: если деталь открылась, эскиз уже потрачен, а повтор её не тронет';"],
  [HOST, "const OFFLINE = 'Нет связи с сервером';"],
  [HOST, "const BUSY = 'Кузнец ещё работает — дождись ответа';"],
  [HOST, "const sig = `${link.state?.save.charId ?? ''}|${craftSig(input)}`;"],
  [HOST, "if (!r.ok) return { ok: false, reason: r.reason ?? 'Кузнец отказал' };"],
  [HOST, "return got ? { ok: true, item: got.item } : { ok: true, reason: 'Скована раньше: этой вещи уже нет в сумке' };"],
  [HOST, "(r) => (r.ok ? { ok: true, reason: r.unlocked?.join(' · ') } : { ok: false, reason: r.reason ?? 'Кузнец отказал' }),"],
  [HOST, "(r) => (r.ok ? { ok: true } : { ok: false, reason: r.reason ?? 'Не надевается' }),"],
  [HOST, "'Нет ответа: посмотри экипировку'),"],
  [HOST, "if (rarity !== 'magic' && rarity !== 'rare') return { ok: false, reason: 'Зачаровать можно до магической или редкой' };"],
  [HOST, "return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');"],
  // вкладка кузницы (forgeCraftTab.ts, forgePanel.ts)
  [TAB, "return ok(cls) ? cls : ok('sword') ? 'sword' : reg.get('weapon-anatomy').map((a) => a.id).find(ok) ?? 'sword';"],
  [TAB, "const ok = (c: string | undefined): c is string => !!c && !!anatomyOf(reg, c) && forgeableFamilies(reg, c).length > 0;"],
  [FORGE, "[['work', '🔨 Работа'], ['craft', '⚒ Ковка'], ['buy', '🛒 Купить']] as const,"],
  [FORGE, "body.append(note('Кузнец ещё не куёт', 'Ковка из деталей откроется позже. Разбор у кузнеца уже пополняет каталог: тип и детали любого оружия, снаряжение.'"],
  [FORGE, "+ (sketches > 0 ? ` Эскизов: ${sketches} — здесь откроешь ими детали на выбор, когда кузнец начнёт ковать.` : '')));"],
  [FORGE, "body.append(stashLoad === 'wait' ? note('Кузнец листает журнал…', '')"],
  [FORGE, ": lostNote('Журнал не загрузился', 'Сервер не отдал сундук аккаунта, а без журнала кузнец не знает, что открыто.'));"],
  // резолверы тултипа (app.ts, damageTypes.ts)
  [APP, "armorClass: (id) => this.config.get('armor-classes').find((c) => c.id === id)?.name ?? id,"],
  [APP, "weight: (id) => (this.config.get('weapon-weights').find((w) => w.id === id)?.name ?? id).toLowerCase(),"],
  [APP, "const sub = this.config.get('phys-subtypes').find((s) => s.id === id);"],
  [APP, 'return sub ? `${sub.name.toLowerCase()} → ${debuffLabel(this.config.get(\'debuffs\'), sub.kind).toLowerCase()}` : id;'],
  [APP, "skill: (id) => this.config.get('skill-tree').nodes.find((n) => n.id === id)?.name ?? id,"],
  [APP, "const phys = this.config.get('damage-kinds').find((k) => k.id === 'physical');"],
  [APP, "this.config.get('magic-subtypes').map((s) => [s.id, { name: s.name, short: s.short, color: s.color, ailment: s.ailment }]),"],
  [DMG, 'return meta[id]?.short ?? id;'],
  // хват оружия (poseRuntime.ts loadGrip, poseLayers.ts splitHands, weapon3d.ts attachWeapons)
  [RUNTIME, 'cfg[charId]?.[k] ?? (fallbackId ? cfg[fallbackId]?.[k] : undefined);'],
  [RUNTIME, 'const exact = slot(weapon);'],
  [RUNTIME, "const mainAlone = m !== 'none' ? slot(m) : undefined;"],
  [RUNTIME, "const offAlone = o !== 'none' ? slot('none+' + o) : undefined;"],
  [RUNTIME, 'exact?.main ?? mainAlone?.main ?? null,'],
  [RUNTIME, 'exact?.off ?? offAlone?.off ?? offAlone?.main ?? null,'],
  [LAYERS, "const w = weapon === 'dual' ? 'sword+dagger' : weapon;      // легаси-ключ дуала"],
  [LAYERS, "return i > 0 ? [w.slice(0, i), w.slice(i + 1)] : [w, 'none'];"],
  [WEAPON3D, "if (kind === 'none') { groups.push(new THREE.Group()); return; }"],
  [WEAPON3D, "if (kind === 'shield') { g.rotation.set(Math.PI / 2, 0, 0); g.position.set(0, 0, 0); }   // диск лицом вперёд, в кулаке"],
  [WEAPON3D, "else if (kind === 'bow') { g.rotation.set(0, 0, 0); }                                        // лук уже вертикальный (дуга в XY)"],
  [WEAPON3D, 'else g.rotation.set(-Math.PI / 2, 0, 0);                                                    // клинок/древко — вперёд (+Z), параллельно земле'],
  [WEAPON3D, "const craftLook = kind !== 'shield' && craft && look ? look : undefined;"],
  [WEAPON3D, "if (weapon === 'dual') weapon = 'sword+dagger';   // легаси-алиас старого комбо"],
  [WEAPON3D, "if (weapon === 'none') return groups;"],
  [WEAPON3D, "if (plus > 0) { attach(weapon.slice(0, plus), 'RightHand', models?.main, look?.main); attach(weapon.slice(plus + 1), 'LeftHand', models?.off, look?.off); }   // main+off: щит ИЛИ второе оружие в левую руку"],
  [WEAPON3D, "else if (weapon === 'shield') { attach('shield', 'LeftHand', models?.off ?? models?.main); }   // только щит (в офф-руке)"],
  [WEAPON3D, "else if (weapon === 'bow') { attach('bow', 'LeftHand', models?.main, look?.main); }"],
  [WEAPON3D, "else attach(weapon, 'RightHand', models?.main, look?.main);"],
];

// ── конфиг эталона ────────────────────────────────────────────────────────────────────────────────

/**
 * Боевой конфиг + приманки, мимо которых порт обязан пройти так же, как ядро: выключенное `iron-5` (материал «ещё не в игре»: ковка
 * отказывает, чип пунктиром), выключенная ступень `t4` (R12-08: ковка на неё — отказ), выключенная копия ключевой детали меча, и снятые с
 * игры гнёзда (V-B3-06): класс, у которого целое гнездо выключено («Кузнец сейчас не куёт этот класс»), и одно семейство двуручного класса
 * («… это семейство»), если конфиг такое даёт; форма меча без базы («не задаёт тип») и без вилки клинка; окна ступеней баз; доводка с
 * полом вне сетки сотых.
 */
const ORDER = ['sword', 'dagger', 'axe', 'mace', 'spear', 'halberd', 'bow', 'crossbow', 'wand', 'staff'];
/** Детали, снятые с игры ради простоя класса и семейства (для отчёта). */
let idleParts: string[] = [];
const reg = (() => {
  const r = new ConfigRegistry();
  r.loadAll();
  const parts = r.get('weapon-parts');
  const off = new Set<string>();
  // Класс целиком: с конца списка окна (меч, топор и прочие ходовые — живыми), первое гнездо класса, все варианты которого — его одного.
  const tail = [...r.get('weapon-anatomy')].sort((x, y) => ORDER.indexOf(y.id) - ORDER.indexOf(x.id));
  outer: for (const a of tail) {
    for (const slot of CRAFT_SLOT_LIST) {
      const pool = parts.filter((p) => p.enabled !== false && p.slot === slot && (p.classes as string[]).includes(a.id));
      if (pool.length && pool.every((p) => p.classes.length === 1)) { for (const p of pool) off.add(p.id); break outer; }
    }
  }
  // Одно семейство: гнездо двуручного семейства, у которого все варианты — только этого класса и только двуручные.
  famOuter: for (const a of tail) {
    if (familiesOf(r, a.id).length < 2 || a.id === 'sword') continue;
    for (const slot of CRAFT_SLOT_LIST) {
      const pool = parts.filter((p) => p.enabled !== false && p.slot === slot && (p.classes as string[]).includes(a.id) && (!p.hands.length || p.hands.includes(2)));
      if (pool.length && pool.every((p) => p.classes.length === 1 && p.hands.length === 1 && p.hands[0] === 2 && !off.has(p.id))) {
        for (const p of pool) off.add(p.id);
        break famOuter;
      }
    }
  }
  const blade = parts.find((p) => p.id === 'sw-s-xxii')!;
  idleParts = [...off];
  r.reload({
    'craft-materials': r.get('craft-materials').map((m) => (m.id === 'iron-5' ? { ...m, enabled: false } : m)),
    'item-tiers': r.get('item-tiers').map((t) => (t.id === 't4' ? { ...t, enabled: false } : t)),
    // Окна ступеней баз (в поставке все t0–t6): короткий меч не выше t3, клеймор не ниже t2 — отказы «не бывает выше/ниже» и «· до t3».
    'items.base': r.get('items.base').map((b) => (b.id === 'short-sword' ? { ...b, maxTier: 't3' } : b.id === 'claymore' ? { ...b, minTier: 't2' } : b)),
    // Доводка с полом вне сетки сотых (0.333 → бросок не ниже 0.34, `snapFloor`) — край вилки обязан совпасть с ковкой.
    balance: { ...r.get('balance'), craft: { ...r.get('balance').craft, finish: [...r.get('balance').craft.finish, { id: 'odd', name: 'Неровная доводка', floor: 0.333, strikeUnits: 2, goldMult: 1.1 }] } },
    'weapon-parts': [...parts.map((p) => (off.has(p.id) ? { ...p, enabled: false } : p)), { ...blade, id: 'sw-s-xxii-off', enabled: false },
      // Форма без базы в таблице типов («не задаёт тип») и без вилки клинка (оговорка «нет вилки по тегу»).
      { ...blade, id: 'sw-s-orphan', name: 'Сирота', tags: { ...blade.tags, blade: 'no-bracket' } }],
  });
  return r;
})();

/** Поля объекта по списку (нет поля — нет и ключа). */
function pick(o: object, keys: readonly string[]): Record<string, unknown> {
  const src = o as Record<string, unknown>;
  return Object.fromEntries(keys.filter((k) => src[k] !== undefined).map((k) => [k, src[k]]));
}
/** NaN и бесконечность — `null` (JSON их не держит). */
const num = (v: number): number | null => (Number.isFinite(v) ? v : null);
/** Вещь без `uid` (его рождают часы): правила его не читают. */
const noUid = (it: Item | undefined): Record<string, unknown> | null => {
  if (!it) return null;
  const { uid: _u, ...rest } = it;
  return rest as Record<string, unknown>;
};

// ── копии подписей окна (craftPanel.ts) ───────────────────────────────────────────────────────────
const RARITY_NAME: Record<string, string> = { common: 'обычная', uncommon: 'нечастая', rare: 'редкая' };
const pct = (x: number, d = 0): string => `${(x * 100).toFixed(d)} %`;
const fx = (x: number, d = 1): string => x.toFixed(d);
const signed = (x: number, unit = '', d = 0): string => `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(x).toFixed(d)}${unit}`;
const IDLE_CLASS = 'Кузнец сейчас не куёт этот класс';
const IDLE_FAMILY = 'Кузнец сейчас не куёт это семейство';
function idleReason(weaponClass: string, hands: number): string {
  if (defaultParts(reg, weaponClass, hands, 2)) return '';
  return forgeableFamilies(reg, weaponClass).length ? IDLE_FAMILY : IDLE_CLASS;
}
type Ranges = NonNullable<ReturnType<typeof craftWeapon>['ranges']>;
function rollVerdict(item: Item, ranges: Ranges | undefined, floor: number): string {
  const mn = item.baseStats.find((m) => m.stat === 'minDamage' && m.kind === 'flat')?.value;
  const mx = item.baseStats.find((m) => m.stat === 'maxDamage' && m.kind === 'flat')?.value;
  if (mn === undefined || mx === undefined || !ranges?.minDamage || !ranges.maxDamage) return '';
  const k = item.damageMult ?? 1, r = (v: number): number => Math.round(v * k);
  const q = item.baseRoll ? ((item.baseRoll.minDamage ?? 0.5) + (item.baseRoll.maxDamage ?? 0.5)) / 2 : 0.5;
  const pos = floor >= 1 ? 100 : Math.round((Math.max(0, q - floor) / (1 - floor)) * 100);
  return ` · урон ${r(mn)}–${r(mx)} из вилки ${rangeLabel(ranges.minDamage, k)}–${rangeLabel(ranges.maxDamage, k)} · бросок ${pos} % вилки`;
}
const FORM_NAME: Record<string, string> = { falchion: 'фальшион', sabre: 'сабля' };
const axisLabel = (x: number): string => `${x > 0 ? '+' : ''}${Math.round(x * 100) / 100}`;
function partCaption(p: WeaponPart): string {
  const b = bladeStats(reg, p);
  return b ? bladeCaption(b) : p.caption;
}
function bladeMeasureLine(p: WeaponPart): string {
  const b = bladeStats(reg, p), g = p.geom;
  if (!b || !g) return '';
  const br = b.bracket;
  const fk = b.form ? reg.get('balance').craft.blade.forms[b.form] : undefined;
  return [
    `клинок ${g.len} см${br ? ` · вилка «${br.name}» ${br.lo}–${br.hi} см` : ' · вне вилок'}${b.outOfBracket && br ? ' (вне вилки — ось в упоре)' : ''} → место ${signed(b.place, '', 2)}, ось ${signed(b.axis, '', 2)}`,
    `ширина ${g.width} см${br ? ` (эталон ${br.width})` : ''} → разброс ×${fx(b.spread, 2)}`,
    `центр тяжести ${pct(g.bal)} длины → баланс клинка ${signed(b.balance, '', 2)}`,
    fk && b.form ? `${FORM_NAME[b.form]}: длина ${signed(fk.length, '', 2)}, баланс ${signed(fk.balance, '', 2)}` : '',
  ].filter(Boolean).join('\n');
}
function partEffect(slot: CraftSlot, part: WeaponPart, st: CraftWindowState, baseId: string | undefined): string {
  const k = reg.get('balance').craft;
  const weaponClass = st.weaponClass;
  if (slot === 'strike') {
    const b = bladeStats(reg, part);
    const axis = b?.axis ?? part.axis;
    const out = [`урон ×${fx(1 + k.strike.damagePct * axis, 2)}`, `скорость ×${fx(1 - k.strike.attackSpeed * axis, 2)}`];
    if (b) out.push(`разброс ×${fx(b.spread, 2)}`);
    if (b?.form) out.push(FORM_NAME[b.form]!);
    return out.join(' · ');
  }
  const axis = part.axis;
  if (slot === 'grip') {
    const r = k.gripK ** axis, a = k.gripK ** (-2 * axis);
    return ['bow', 'crossbow', 'wand', 'staff'].includes(weaponClass) ? 'только вид (§5.2)' : `дальность ×${fx(r, 2)} · дуга ×${fx(a, 2)}`;
  }
  if (slot === 'bind') return axis > 0 ? 'больше префиксов' : axis < 0 ? 'больше суффиксов' : 'поровну';
  const strike = partById(reg, st.parts.strike.id);
  const bal = strike ? balanceAxisOf(reg, strike, part) : axis;
  const lead = strike && bladeStats(reg, strike) ? `баланс ${signed(bal, '', 2)}: ` : '';
  const base = reg.get('items.base').find((b) => b.id === baseId);
  const own = base?.baseStats.filter((m) => m.stat === 'blockChance' && m.kind === 'flat').reduce((s, m) => s + m.value, 0) ?? 0;
  const floor = weaponClass === 'bow' ? (bal < 0 ? ' (в ноль)' : '') : base && own + k.headBlock * bal < 0 ? ` (у базы ${fx(own * 100, 0)} % — в ноль)` : '';
  const brace = (weaponClass === 'bow' ? `стойкость ${signed(k.headInterrupt * bal * 100, ' п.п.', 1)}` : `блок ${signed(k.headBlock * bal * 100, ' п.п.', 1)}`) + floor;
  const kind = base?.kind === 'weapon' ? statusKindOf(reg, base) : undefined;
  if (base && !(kind && k.bite[kind])) return `${lead}${brace}`;
  const name = kind ? reg.get('debuffs').find((d) => d.id === kind)?.name.toLowerCase() ?? kind : 'статус';
  return `${lead}${brace} · ${name} ${bal < 0 ? 'чаще' : bal > 0 ? 'реже' : 'как есть'}`;
}
function sketchElsewhere(j: CraftJournal, p: WeaponPart, weaponClass: string, hands: number): string {
  if (p.slot !== keySlotOf(reg, weaponClass)) return '';
  const here = baseOfKeyPart(reg, weaponClass, hands, p);
  if (here && j.bases.includes(here)) return '';
  const where = new Set<string>();
  for (const cls of p.classes as string[]) {
    if (p.slot !== keySlotOf(reg, cls)) { where.add(reg.get('weapon-anatomy').find((a) => a.id === cls)?.name ?? cls); continue; }
    for (const h of [1, 2]) {
      const b = baseOfKeyPart(reg, cls, h, p);
      if (b && j.bases.includes(b)) where.add(`«${reg.get('items.base').find((x) => x.id === b)?.name ?? b}»`);
    }
  }
  return [...where].join(', ');
}
function baseLine(baseId: string | undefined): string {
  const base = reg.get('items.base').find((b) => b.id === baseId);
  if (!base || base.kind !== 'weapon') return '';
  const flat = (s: string): number | undefined => base.baseStats.find((m) => m.stat === s && m.kind === 'flat')?.value;
  const w = reg.get('weapon-weights').find((x) => x.id === base.weight);
  const edge = base.physSub ? reg.get('phys-subtypes').find((p) => p.id === base.physSub)?.name.toLowerCase() : reg.get('magic-subtypes').find((m) => m.id === base.damageType)?.name?.toLowerCase();
  const dmg = flat('minDamage') !== undefined ? `${flat('minDamage')}–${flat('maxDamage')}` : '';
  return [base.name, dmg, base.hands === 2 ? 'двуручное' : 'одноручное', edge ?? 'без грани', w ? `вес: ${w.name.toLowerCase()}` : ''].filter(Boolean).join(' · ');
}

// ── резолверы тултипа (app.ts) ────────────────────────────────────────────────────────────────────
const meta: Record<string, { short: string }> = (() => {
  const phys = reg.get('damage-kinds').find((k) => k.id === 'physical');
  return {
    ...(phys ? { physical: { short: phys.short } } : {}),
    ...Object.fromEntries(reg.get('magic-subtypes').map((s) => [s.id, { short: s.short }])),
  };
})();
const R: ItemLabels = {
  armorClass: (id) => reg.get('armor-classes').find((c) => c.id === id)?.name ?? id,
  weight: (id) => (reg.get('weapon-weights').find((w) => w.id === id)?.name ?? id).toLowerCase(),
  physSub: (id) => {
    const sub = reg.get('phys-subtypes').find((s) => s.id === id);
    return sub ? `${sub.name.toLowerCase()} → ${debuffLabel(reg.get('debuffs'), sub.kind).toLowerCase()}` : id;
  },
  skill: (id) => reg.get('skill-tree').nodes.find((n) => n.id === id)?.name ?? id,
  dmgShort: (id) => meta[id]?.short ?? id,
};
/** Тултип вещи (`itemTooltipHtml`): имя с подписью слота и строки `describeItem` с признаком аффикса. */
const tip = (it: Item) => ({ name: `${it.name}${slotSuffix(it)}`, rarity: it.rarity, lines: describeItem(it, R) });

// ── журналы и кейсы ───────────────────────────────────────────────────────────────────────────────

/** Детерминированный «хэш» строки в [0, 1) — какие базы и детали открыты в частичном журнале. */
const h01 = (s: string, salt: number): number => {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000;
};
const JOURNALS: Record<string, CraftJournal> = (() => {
  const full = fullJournal(reg);
  const last = craftTiers(reg).length - 1;
  const partial = (salt: number, tierHi: number, sketches: number): CraftJournal => ({
    ...emptyJournal(),
    bases: full.bases.filter((b) => h01(b, salt) < 0.6),
    variants: full.variants.filter((v) => h01(v, salt + 7) < 0.55),
    tierHi, sketches,
  });
  return {
    full,
    empty: emptyJournal(),
    low: { ...full, tierHi: 1, mythic: 0 },
    gate: { ...full, tierHi: last, mythic: 0 },
    partial: partial(11, 3, 0),
    sketchy: partial(23, 5, 3),
  };
})();

/**
 * ⭐ 06.10: журналы ТОЛЬКО для начального состояния окна по журналу (`journalDefaultStep`) — потолок t0 (первый разбор «Убогой»
 * вещи — случай жалобы владельца) и t2. Отдельно от `JOURNALS`, чтобы не сдвигать случайные выборки остальных разделов.
 */
const INIT_JOURNALS: Record<string, CraftJournal> = (() => {
  const full = fullJournal(reg);
  return { t0: { ...full, tierHi: 0, mythic: 0 }, t2: { ...full, tierHi: 2, mythic: 0 } };
})();

/** Кошельки: богатый (всё по 1000), пустой, частичный (по 10 первых ступеней). */
const WALLETS: Record<string, Record<string, number>> = {
  rich: Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, 1000])),
  broke: {},
  some: Object.fromEntries(reg.get('craft-materials').filter((m) => m.tier <= 2).map((m) => [m.id, 10 + m.tier])),
};

/** Сумки (V-B3-03 `craftFits`): пустая, полная зельями, полная зельями и стеками сырья (сырьё уходит — клетка освобождается). */
const BAGS: Record<string, Item[]> = (() => {
  const dims = reg.get('balance').inventory;
  const potion = itemFromBaseId(reg.get('items.base'), 'healing-potion', undefined, 'shop')!;
  const fill = (items: Item[]): Item[] => {
    const bag = items.map((it) => ({ ...it }));
    let k = 0;
    for (let y = 0; y < dims.rows; y++) for (let x = 0; x < dims.cols; x++) {
      const free = bag.every((o) => !o.pos || x >= o.pos.x + o.gridW || x + 1 <= o.pos.x || y >= o.pos.y + o.gridH || y + 1 <= o.pos.y);
      if (free) bag.push({ ...potion, uid: `fill-${k++}`, pos: { x, y } });
    }
    return bag;
  };
  const mats = reg.get('craft-materials').filter((m) => m.enabled);
  const stacks = mats.slice(0, 18).map((m, i) => ({ ...materialItem(m, 16 + (i % 5) * 4, `st-${m.id}`), pos: { x: i % dims.cols, y: Math.floor(i / dims.cols) } }));
  return { empty: [], full: fill([]), stacked: fill(stacks) };
})();

const ANAT_IDS = (): string[] => [...reg.get('weapon-anatomy')].sort((x, y) => ORDER.indexOf(x.id) - ORDER.indexOf(y.id)).map((a) => a.id);

/** Раздел `families`: класс → семейства, какие кузнец куёт, причина простоя, ключевое гнездо, умолчание сборки. */
function familyCases() {
  return ANAT_IDS().map((cls) => ({
    cls,
    families: familiesOf(reg, cls),
    forgeable: forgeableFamilies(reg, cls),
    keySlot: keySlotOf(reg, cls),
    idle: Object.fromEntries(familiesOf(reg, cls).map((h) => [String(h), idleReason(cls, h)])),
    defaults: Object.fromEntries(familiesOf(reg, cls).flatMap((h) => [1, 2, 5].map((s) => [`${h}:${s}`, defaultParts(reg, cls, h, s)]))),
    pools: Object.fromEntries(familiesOf(reg, cls).map((h) => [String(h), {
      groups: keyVariantsByBase(reg, cls, h).map((g) => ({ baseId: g.baseId, variants: g.variants.map((p) => p.id) })),
      slots: Object.fromEntries(CRAFT_SLOT_LIST.map((s) => [s, variantsFor(reg, cls, s, h).map((p) => p.id)])),
    }])),
  }));
}

/** Раздел `parts`: по каждой детали — ось, подпись, замер клинка, ступени материала (по семействам, где деталь годна), эскиз в журналах. */
function partCases() {
  return reg.get('weapon-parts').map((p) => {
    const b = bladeStats(reg, p);
    const fams: Record<string, string[]> = {};
    for (const cls of p.classes as string[]) {
      const anat = anatomyOf(reg, cls);
      if (!anat) continue;
      fams[cls] = [1, 2, 3, 4, 5].map((k) => stepLabel(reg, anat, p.slot as CraftSlot, p, k));
    }
    return {
      id: p.id, axis: axisOf(reg, p), axisLabel: axisLabel(axisOf(reg, p)), caption: partCaption(p), measure: bladeMeasureLine(p),
      blade: b ? { ...b, bracket: b.bracket?.tag ?? null } : null,
      clamp: [-1, 0, 1, 2.5, 3, 4.5, 5, 9].map((s) => clampStep(p, s)),
      stepLabels: fams,
      sketchable: Object.fromEntries(Object.keys(JOURNALS).map((j) => [j, sketchable(reg, JOURNALS[j]!, p.id)])),
      elsewhere: Object.fromEntries(Object.keys(JOURNALS).map((j) => [j, (p.classes as string[]).flatMap((cls) => familiesOf(reg, cls).map((h) => sketchElsewhere(JOURNALS[j]!, p, cls, h)))])),
    };
  });
}

/** Строки баз (заголовки групп ключевых форм и «механика: …»). */
const baseLines = () => Object.fromEntries(reg.get('items.base').filter((b) => b.kind === 'weapon').map((b) => [b.id, { line: baseLine(b.id), range: baseTierRange(reg, b) }]));

/** Случайная сборка семейства: чаще — честная (детали своего пула, ступени в окне), реже — с изъяном. */
function randomInput(cls: string, hands: number, rng: ReturnType<typeof createRng>): CraftInput {
  const keySlot = keySlotOf(reg, cls);
  const all = reg.get('weapon-parts');
  const parts = {} as CraftParts;
  for (const slot of CRAFT_SLOT_LIST) {
    const pool = slot === keySlot ? keyVariantsByBase(reg, cls, hands).flatMap((g) => g.variants) : variantsFor(reg, cls, slot, hands);
    const roll = rng.next();
    let p: WeaponPart | undefined;
    if (roll < 0.86 && pool.length) p = rng.pick(pool);
    else if (roll < 0.92) p = rng.pick(all.filter((x) => x.slot === slot));          // чужого класса или хвата
    else if (roll < 0.96) p = rng.pick(all);                                           // чужого гнезда
    const id = p ? p.id : rng.chance(0.5) ? '' : 'no-such-part';
    const s = rng.next();
    const step = p && s < 0.85 ? rng.int(p.stepMin, p.stepMax) : s < 0.95 ? rng.int(1, 5) : rng.pick([0, 6]);
    parts[slot] = { id, step };
  }
  const f = rng.next();
  const finish = f < 0.55 ? 0 : f < 0.9 ? rng.int(1, reg.get('balance').craft.finish.length - 1) : rng.pick([-1, 1.5, 2.4, 99]);
  return { weaponClass: cls, hands, parts, finish };
}

/** Итог предпросмотра — поля `CraftPreview` (вещь без uid) и тултип вещи. */
function previewOut(pv: ReturnType<typeof craftWeapon>) {
  return {
    ok: pv.ok, reason: pv.reason ?? null,
    type: pv.type ? pick(pv.type, ['ok', 'reason', 'baseId', 'typeId', 'name', 'gender', 'subtitle', 'formula', 'fallback']) : null,
    tier: pv.tier ?? null, q: pv.q ?? null,
    bake: pv.bake ? pick(pv.bake, ['damageMult', 'mods', 'reachMult', 'arcMult', 'affixCap', 'statusKind', 'spread', 'balance', 'notes']) : null,
    cost: pv.cost ?? null,
    ranges: pv.ranges ?? null,
    item: noUid(pv.item),
    tip: pv.item ? tip(pv.item) : null,
  };
}

/** Раздел `previews`: случайные сборки каждого семейства в каждом журнале, в игре (материалы проверяются) и в песочнице. */
function previewCases() {
  const rng = createRng(4242);
  const out: unknown[] = [];
  for (const cls of ANAT_IDS()) {
    const fams = familiesOf(reg, cls);
    for (const hands of fams.length ? fams : [1]) {
      for (const jn of Object.keys(JOURNALS)) {
        for (let i = 0; i < 6; i++) {
          const input = randomInput(cls, hands, rng);
          const materialsOn = i % 5 !== 4;
          out.push({ input, journal: jn, materialsOn, out: previewOut(craftWeapon(reg, input, { journal: JOURNALS[jn], materialsOn })) });
        }
      }
      // Каждая форма ключа хотя бы раз — эталоном «всё открыто»: тип, имя, род, формула и вилка каждой базы.
      for (const g of keyVariantsByBase(reg, cls, hands)) {
        for (const kp of g.variants) {
          const def = defaultParts(reg, cls, hands, 3);
          if (!def) continue;
          const keySlot = keySlotOf(reg, cls);
          const input: CraftInput = { weaponClass: cls, hands, parts: { ...def, [keySlot]: { id: kp.id, step: clampStep(kp, 3) } }, finish: rng.int(0, 3) };
          out.push({ input, journal: 'full', materialsOn: true, out: previewOut(craftWeapon(reg, input, { journal: JOURNALS.full, materialsOn: true })) });
        }
        // Края окна ступеней базы: всё на верхней ступени формы («не бывает выше») и на нижней («не бывает ниже»).
        const def = defaultParts(reg, cls, hands, 3);
        const kp = g.variants[0];
        if (!def || !kp) continue;
        for (const edge of ['hi', 'lo'] as const) {
          const parts = {} as CraftParts;
          for (const s of CRAFT_SLOT_LIST) {
            const p = s === keySlotOf(reg, cls) ? kp : partById(reg, def[s].id)!;
            parts[s] = { id: p.id, step: edge === 'hi' ? p.stepMax : p.stepMin };
          }
          const input: CraftInput = { weaponClass: cls, hands, parts, finish: 0 };
          for (const jn of edge === 'hi' ? ['full', 'gate', 'low'] : ['full']) {
            out.push({ input, journal: jn, materialsOn: true, out: previewOut(craftWeapon(reg, input, { journal: JOURNALS[jn], materialsOn: true })) });
          }
        }
      }
    }
  }
  // Форма без базы: тип не задаётся (и в журнале «всё», и без него).
  const sw = defaultParts(reg, 'sword', 1, 2)!;
  for (const jn of ['full', 'empty']) {
    const input: CraftInput = { weaponClass: 'sword', hands: 1, parts: { ...sw, strike: { id: 'sw-s-orphan', step: 2 } }, finish: 0 };
    out.push({ input, journal: jn, materialsOn: true, out: previewOut(craftWeapon(reg, input, { journal: JOURNALS[jn], materialsOn: true })) });
  }
  // Без журнала (`journal` не передан — всё открыто, ворот нет): так считает песочница.
  for (const cls of ANAT_IDS()) for (const hands of familiesOf(reg, cls)) {
    const input = randomInput(cls, hands, rng);
    out.push({ input, journal: null, materialsOn: false, out: previewOut(craftWeapon(reg, input, {})) });
  }
  return out;
}

/** Раздел `states`: начальное состояние окна и приведение выбора к допустимому в каждом журнале — в том числе из испорченного. */
function stateCases() {
  const rng = createRng(777);
  const out: unknown[] = [];
  const snap = (st: CraftWindowState) => ({ weaponClass: st.weaponClass, hands: st.hands, parts: structuredClone(st.parts), finish: st.finish ?? null });
  for (const cls of ANAT_IDS()) {
    for (const hands of [undefined, ...familiesOf(reg, cls), 3]) {
      const init = initialCraftState(reg, cls, hands);
      out.push({ op: 'init', cls, hands: hands ?? null, out: snap(init) });
      // ⭐ 06.10: окно игры открывается с журналом — ступень не выше его потолка (`journalDefaultStep`)
      for (const [jn, jj] of [...Object.entries(JOURNALS), ...Object.entries(INIT_JOURNALS)]) {
        // ⭐ D3: журнал на ступень окна больше не влияет — случаи с журналом остаются, чтобы порт Unity снял прежний прижим к потолку.
        void jj;
        out.push({ op: 'init', cls, hands: hands ?? null, journal: jn, out: snap(initialCraftState(reg, cls, hands)) });
      }
      for (const jn of Object.keys(JOURNALS)) {
        const st = initialCraftState(reg, cls, hands);
        const before = snap(st);
        normalizeCraftState(reg, st, JOURNALS[jn]!);
        out.push({ op: 'normalize', journal: jn, in: before, out: snap(st) });
      }
    }
    for (const jn of Object.keys(JOURNALS)) {
      for (let i = 0; i < 4; i++) {
        const fams = familiesOf(reg, cls);
        const hands = rng.chance(0.85) && fams.length ? rng.pick(fams) : 3;
        const input = randomInput(cls, hands, rng);
        const st: CraftWindowState = { weaponClass: cls, hands, parts: structuredClone(input.parts), crafted: null, message: '', finish: input.finish };
        if (i === 3) (st as { parts?: CraftParts }).parts = undefined as unknown as CraftParts;   // окно без сборки — эталон семейства
        const before = { weaponClass: st.weaponClass, hands: st.hands, parts: st.parts ? structuredClone(st.parts) : null, finish: st.finish ?? null };
        normalizeCraftState(reg, st, JOURNALS[jn]!);
        out.push({ op: 'normalize', journal: jn, in: before, out: snap(st) });
      }
    }
  }
  return out;
}

/** Раздел `finish`: строка доводки по индексу (`finishOf` — прижатие и округление). */
const finishCases = () => [-3, -1, 0, 0.4, 0.5, 1, 1.5, 2, 2.5, 3, 7, 99].map((i) => ({ i, out: finishOf(reg, i) }));

/** Скованная вещь для окна: настоящая ковка с броском, её зачарованные, сломанная, с формой без цены и с пустым пулом. */
function craftedItems(): { name: string; item: Item; ranges?: Ranges; floor: number }[] {
  const out: { name: string; item: Item; ranges?: Ranges; floor: number }[] = [];
  let seed = 90;
  for (const [cls, hands] of [['sword', 1], ['axe', 2], ['staff', 2], ['bow', 2], ['dagger', 1]] as const) {
    const def = defaultParts(reg, cls, hands, 3);
    if (!def) continue;
    for (const finish of [0, 2, 3]) {
      const input: CraftInput = { weaponClass: cls, hands, parts: def, finish };
      const pv = craftWeapon(reg, input, {});
      const done = craftWeapon(reg, input, { rng: createRng(seed++) });
      if (!done.ok || !done.item) continue;
      const it = { ...done.item, uid: `cr-${out.length}` };
      out.push({ name: `${cls}-${hands}-${finish}`, item: it, ranges: pv.ranges, floor: pv.cost?.finish?.floor ?? 0 });
      if (finish === 0) {
        for (const r of ['magic', 'rare'] as const) {
          const e = enchantItem(reg, it, r, createRng(seed++));
          if (e) out.push({ name: `${cls}-${hands}-${r}`, item: e, floor: 0 });
        }
        out.push({ name: `${cls}-${hands}-broken`, item: { ...it, broken: true }, floor: 0 });
        out.push({ name: `${cls}-${hands}-unpriced`, item: { ...it, affixCap: { prefix: 3, suffix: 3 } }, floor: 0 });
        out.push({ name: `${cls}-${hands}-empty-pool`, item: { ...it, itemLevel: 0 }, floor: 0 });
        out.push({ name: `${cls}-${hands}-no-cap`, item: { ...it, affixCap: { prefix: 0, suffix: 0 } }, floor: 0 });
      }
    }
  }
  out.push({ name: 'no-base', item: { ...out[0]!.item, baseId: 'no-such-base' }, floor: 0 });
  return out;
}

/**
 * ⭐ Раздел `views`: ОКНО КОВКИ целиком, как его рисует `craftWindow` (копия разметки в данные): классы, семейство, шапка (имя, ступень,
 * Q, подсказка, механика, причина), эскизы, «Вся вещь из», четыре карточки гнёзд (строки деталей, материалы, подписи), вещь (тултип,
 * ёмкость, оговорки), доводка, цена против кошелька, кнопки с причинами и итог последнего действия.
 */
interface ViewIn {
  st: CraftWindowState; journal: string; wallet: string; gold: number; bag: string | null; sketch: boolean;
  craftedInBag?: boolean;
}
function view(v: ViewIn) {
  const st = v.st;
  const j = JOURNALS[v.journal]!;
  normalizeCraftState(reg, st, j);
  const anat = anatomyOf(reg, st.weaponClass);
  const tiers = craftTiers(reg);
  const mats = reg.get('craft-materials');
  const matName = (id: string): string => mats.find((m) => m.id === id)?.name ?? id;
  const matOn = (id: string): boolean => mats.find((m) => m.id === id)?.enabled !== false;
  const keySlot = keySlotOf(reg, st.weaponClass);
  const busy = !!st.busy;
  const sketches = v.sketch ? j.sketches : 0;
  if (st.sketchPick && (sketches <= 0 || !sketchable(reg, j, st.sketchPick))) st.sketchPick = undefined;
  const wallet = WALLETS[v.wallet]!;
  const craftedInBag = v.craftedInBag ?? true;

  const classes = [...reg.get('weapon-anatomy')].sort((x, y) => ORDER.indexOf(x.id) - ORDER.indexOf(y.id)).map((a) => {
    const idle = !forgeableFamilies(reg, a.id).length;
    return { id: a.id, name: a.name, on: a.id === st.weaponClass, idle, disabled: busy };
  });
  const fams = familiesOf(reg, st.weaponClass);
  const family = fams.length > 1
    ? { chips: fams.map((h) => ({ h, label: h === 2 ? 'Двуручное' : 'Одноручное', on: h === st.hands, idle: !defaultParts(reg, st.weaponClass, h, 2), disabled: busy })) }
    : { text: fams[0] === 2 ? 'Семейство одно: двуручное' : 'Семейство одно: одноручное' };

  const input: CraftInput = { weaponClass: st.weaponClass, hands: st.hands, parts: structuredClone(st.parts), finish: st.finish ?? 0 };
  const pv = craftWeapon(reg, input, { journal: j, materialsOn: true });
  const idle = idleReason(st.weaponClass, st.hands);
  const why = idle || pv.reason;
  const type = pv.type;
  const { q, tier } = tierOfSteps(reg, st.parts);
  const w = reg.get('balance').craft.tierFromParts.weights;
  const head = {
    name: type?.ok ? type.name : '—',
    tier: `${tiers[tier]?.id} ${tiers[tier]?.name}`, tierOk: pv.ok,
    tierTitle: `Средний уровень материала по массе: Q = (${w.strike}·${st.parts.strike.step} + ${st.parts.grip.step} + ${st.parts.bind.step} + ${st.parts.head.step}) / ${w.strike + w.grip + w.bind + w.head} = ${q}`,
    q: `Q = ${fx(q, 2)}`,
    subtitle: type?.ok && type.subtitle ? type.subtitle : null,
    formula: type?.ok && type.formula ? type.formula : null,
    mech: type?.ok ? `механика: ${baseLine(type.baseId)}` : null,
    why: !pv.ok && why ? `⚠ ${why}` : null,
  };

  let sketch: unknown = null;
  if (sketches > 0) {
    const pk = st.sketchPick ? partById(reg, st.sketchPick) : undefined;
    if (!pk) sketch = { text: `✦ Эскизов: ${sketches} — открой закрытую деталь на выбор: нажми на неё в списке (✦). Ключевую форму неоткрытого типа эскиз не открывает — тип открывает разбор.` };
    else {
      const where = sketchElsewhere(j, pk, st.weaponClass, st.hands);
      sketch = {
        text: `✦ Открыть «${pk.name}» эскизом? Эскизов останется ${sketches - 1} — вернуть эскиз нельзя.` + (where ? ` Здесь её тип ещё закрыт (его открывает разбор) — ковать её можно: ${where}.` : ''),
        confirm: st.busy === 'sketch' ? '⏳ открываю…' : '✦ Открыть эскизом', disabled: !!st.busy,
      };
    }
  }

  const all = anat ? [1, 2, 3, 4, 5].map((k) => ({ label: `ст. ${k} · ${matName(`${anat[keySlot].family}-${k}`)}`, on: CRAFT_SLOT_LIST.every((s) => st.parts[s].step === k) })) : null;

  const order: CraftSlot[] = [keySlot, ...CRAFT_SLOT_LIST.filter((s) => s !== keySlot)];
  const slots = order.map((slot) => {
    const isKey = slot === keySlot;
    const rows: unknown[] = [];
    const row = (p: WeaponPart, baseOpen = true) => {
      const known = j.variants.includes(p.id);
      const open = known && baseOpen;
      const bySketch = !known && sketches > 0 && sketchable(reg, j, p.id);
      const elsewhere = bySketch && !baseOpen ? sketchElsewhere(j, p, st.weaponClass, st.hands) : '';
      const on = p.id === st.parts[slot].id || (bySketch && st.sketchPick === p.id);
      rows.push({
        id: p.id, text: `${open ? '' : bySketch ? '✦ ' : '🔒 '}${p.name}`, open, bySketch, on, rarity: p.rarity,
        range: `ст.${p.stepMin}–${p.stepMax}`, axis: axisLabel(axisOf(reg, p)),
        title: [partCaption(p), p.lore, bladeMeasureLine(p), `${RARITY_NAME[p.rarity]} · материал: ступени ${p.stepMin}–${p.stepMax}`,
          bySketch ? `✦ Открыть эскизом (эскизов: ${sketches})` : '',
          elsewhere ? `Здесь её тип ещё закрыт (его открывает разбор) — ковать её можно: ${elsewhere}` : ''].filter(Boolean).join('\n'),
        disabled: (!open && !bySketch) || busy,
      });
    };
    if (isKey) {
      for (const g of keyVariantsByBase(reg, st.weaponClass, st.hands)) {
        const baseOpen = j.bases.includes(g.baseId);
        const b = reg.get('items.base').find((x) => x.id === g.baseId);
        const hr = b ? baseTierRange(reg, b) : { lo: 0, hi: 6 };
        const cap = hr.hi < tiers.length - 1 ? ` · до ${tiers[hr.hi]?.id}` : '';
        rows.push({ head: `${baseOpen ? '' : '🔒 '}${baseLine(g.baseId)}${cap}`, open: baseOpen });
        for (const p of g.variants) row(p, baseOpen);
      }
    } else for (const p of variantsFor(reg, st.weaponClass, slot, st.hands)) row(p);
    const sel = partById(reg, st.parts[slot].id);
    let mat: unknown = null;
    if (sel && anat) {
      const chips = [1, 2, 3, 4, 5].map((k) => {
        const inWin = k >= sel.stepMin && k <= sel.stepMax;
        const id = `${sel.family || anat[slot].family}-${k}`;
        return {
          label: stepLabel(reg, anat, slot, sel, k), on: st.parts[slot].step === k, disabled: !inWin || busy,
          title: inWin ? `${matName(id)} (${id})${matOn(id) ? '' : ' — ещё нет в игре'}` : `«${sel.name}» из этого не куётся: только ступени ${sel.stepMin}–${sel.stepMax}`,
          dashed: inWin && !matOn(id),
        };
      });
      const strikeSel = partById(reg, st.parts.strike.id);
      const measure = bladeMeasureLine(sel);
      const bk = reg.get('balance').craft.blade.balance;
      mat = {
        label: `Материал · ${anat[slot].stepNames.length && !sel.family ? 'обработка' : matName(`${sel.family || anat[slot].family}-${st.parts[slot].step}`)}`,
        chips, caption: partCaption(sel), effect: partEffect(slot, sel, st, type?.baseId),
        effectTitle: measure || (slot === 'head' && strikeSel && bladeStats(reg, strikeSel)
          ? `Точка баланса вещи: ${Math.round(bk.bladeShare * 100)} % — клинок, ${Math.round((1 - bk.bladeShare) * 100)} % — оголовье (+ поправка формы), в ±1.\nВес у руки — упор (блок), вес к концу — укус (статус грани).`
          : null),
      };
    }
    return { slot, title: anat ? slotName(anat, slot, st.hands) : slot, key: isKey, role: CRAFT_SLOT_ROLE[slot], rows, mat };
  });

  const shown = st.crafted ?? pv.item;
  const left: Record<string, unknown> = {
    tip: shown ? tip(shown) : null,
    cap: shown?.affixCap ? `Ёмкость: ${shown.affixCap.prefix} преф. + ${shown.affixCap.suffix} суф. — примет при зачаровании` : null,
    noItem: shown ? null : why || 'Не собирается',
    notes: (pv.bake?.notes ?? []).map((n) => `⚠ ${n}`),
  };
  const finishes = reg.get('balance').craft.finish;
  if (finishes.length > 1 && pv.cost && anat) {
    const strikeMat = pv.cost.lines.find((l) => l.slot === 'strike');
    left.finish = {
      head: `Доводка: ${slotName(anat, 'strike', st.hands)} — поднимает нижнюю границу урона, верх вилки не растёт`,
      chips: finishes.map((f, i) => {
        const extra = f.strikeUnits <= 0 && f.goldMult === 1 ? 'без надбавки' : `+${f.strikeUnits} ${strikeMat ? matName(strikeMat.id) : ''} · золото ×${fx(f.goldMult, 2)}`;
        return { label: f.name, on: (st.finish ?? 0) === i, title: `${extra}\nНиже ${Math.round(f.floor * 100)} % вилки урон не выпадет` };
      }),
    };
  }
  if (pv.cost && anat) {
    const lines = pv.cost.lines.map((l) => {
      const need = pv.cost!.materials[l.id] ?? 0, have = wallet[l.id] ?? 0;
      return { text: `${slotName(anat, l.slot, st.hands)}: ${matName(l.id)} — ${l.n}  (есть ${have})`, ok: have >= need };
    });
    const fc = pv.cost.finish;
    let fin: unknown = null;
    if (fc && fc.n > 0) {
      const need = pv.cost.materials[fc.id] ?? 0, have = wallet[fc.id] ?? 0;
      fin = { text: `${fc.name}: ${matName(fc.id)} — ${fc.n}  (всего ${need}, есть ${have})`, ok: have >= need };
    }
    left.cost = {
      head: `Цена: каждая деталь своим материалом (форма ×${fx(pv.cost.mult, 2)})`, lines, finish: fin,
      gold: { text: `Золото — ${pv.cost.gold}  (есть ${v.gold})`, ok: v.gold >= pv.cost.gold },
    };
  }
  const lack = pv.cost ? craftMissing(wallet, v.gold, pv.cost) : null;
  const short = lack ? [...(Object.keys(lack.materials).length ? [describeCost(reg, lack.materials)] : []), ...(lack.gold > 0 ? [`${lack.gold} золота`] : [])] : [];
  const bag = v.bag ? BAGS[v.bag] : undefined;
  const noRoom = pv.ok && !short.length && !!pv.item && !!pv.cost && !!bag && !craftFits(reg, bag, pv.cost.materials, pv.item);
  left.craft = {
    label: st.busy === 'craft' ? '⏳ куём…' : '🔨 Ковать', disabled: !pv.ok || busy || short.length > 0 || noRoom,
    title: !pv.ok && why ? why : short.length ? `Не хватает: ${short.join(' · ')}` : noRoom ? 'Нет места в сумке' : null,
  };
  if (st.crafted) {
    const item = st.crafted;
    left.enchant = (['magic', 'rare'] as const).map((r) => {
      const cost = enchantCost(reg, item, r);
      const ess = enchantMaterials(reg, item, r);
      const essLack = Object.fromEntries(Object.entries(ess).filter(([id, n]) => (wallet[id] ?? 0) < n).map(([id, n]) => [id, n - (wallet[id] ?? 0)]));
      const essN = Object.values(ess)[0] ?? 0;
      const essHave = wallet[Object.keys(ess)[0] ?? ''] ?? 0;
      const fit = enchantSlots(reg, item, r);
      const why = item.rarity !== 'normal' ? 'Вещь уже зачарована'
        : !craftedInBag ? 'Надетую не зачаровать: сперва сними её в сумку'
        : item.broken ? 'Сперва почини'
        : !fit ? 'Кузнец не знает такой вещи'
        : Math.min(fit.slots.maxAffixes, fit.slots.maxPrefix + fit.slots.maxSuffix) <= 0 ? 'Этой вещи некуда принять свойства'
        : !fit.fillable ? 'Кузнецу не хватит свойств на форму этой вещи'
        : rolledFormMult(reg, item, r) === undefined ? FORM_UNPRICED
        : v.gold < cost ? `Недостаточно золота: нужно ${cost}`
        : Object.keys(essLack).length ? `Не хватает материалов: ${describeCost(reg, essLack)}` : '';
      return {
        label: st.busy === 'enchant' ? '⏳ зачаровываю…' : `✦ ${r === 'magic' ? 'Магический' : 'Редкий'}${essN > 0 ? ` · эссенция ${essN} (есть ${essHave})` : ''}${Number.isFinite(cost) ? ` · ${cost} з.` : ''}`,
        disabled: !!why || busy, title: why || null, cost: num(cost), essence: ess,
      };
    });
    left.equip = craftedInBag ? { label: st.busy === 'equip' ? '⏳ надеваю…' : 'Надеть', disabled: busy } : null;
    left.fresh = { disabled: busy };
  }
  left.message = st.message ? { text: st.message, bad: st.message.startsWith('Не') } : null;
  return { classes, family, head, sketch, all, slots, left, sketchPick: st.sketchPick ?? null };
}

function viewCases() {
  const rng = createRng(31337);
  const crafted = craftedItems();
  const out: unknown[] = [];
  const busies = [undefined, undefined, undefined, 'craft', 'enchant', 'sketch', 'equip'] as const;
  let n = 0;
  for (const cls of ANAT_IDS()) {
    const fams = familiesOf(reg, cls);
    for (const hands of fams.length ? fams : [1]) {
      for (const jn of Object.keys(JOURNALS)) {
        if (jn === 'empty' && n % 2) { n++; continue; }
        const st = initialCraftState(reg, cls, hands);
        // Сборка — случайная из пула (бывает и закрытая), материал — случайный (бывает и вне окна).
        if (rng.chance(0.6)) {
          const input = randomInput(cls, hands, rng);
          for (const s of CRAFT_SLOT_LIST) if (input.parts[s].id && rng.chance(0.7)) st.parts[s] = input.parts[s];
          st.finish = input.finish;
        }
        const busy = busies[n % busies.length];
        if (busy) st.busy = busy;
        if (n % 3 === 0) st.message = rng.pick(['Скована: Ранний меч · урон 9–15 из вилки (8–10)–(14–17) · бросок 40 % вилки', 'Не вышло: Недостаточно золота', 'Надето', CRAFT_UNKNOWN]);
        // Эскиз к открытию: первая закрытая деталь, которую журнал разрешает открыть эскизом.
        if (jn === 'sketchy' && n % 3 !== 1) {
          const cand = reg.get('weapon-parts').find((p) => (p.classes as string[]).includes(cls) && sketchable(reg, JOURNALS[jn]!, p.id));
          if (cand) st.sketchPick = cand.id;
        }
        if (jn === 'partial' && n % 4 === 1) st.sketchPick = 'no-such-part';
        let craftedInBag: boolean | undefined;
        if (n % 4 === 2) {
          const c = crafted[n % crafted.length]!;
          st.crafted = c.item;
          craftedInBag = n % 8 !== 2;
        }
        const vi: ViewIn = {
          st, journal: jn, wallet: rng.pick(['rich', 'broke', 'some']), gold: rng.pick([0, 120, 900, 5000, 1_000_000]),
          bag: rng.pick([null, 'empty', 'full', 'stacked']), sketch: n % 5 !== 4 || !!st.sketchPick, craftedInBag,
        };
        const input = { st: structuredClone(st), journal: vi.journal, wallet: vi.wallet, gold: vi.gold, bag: vi.bag, sketch: vi.sketch, craftedInBag: vi.craftedInBag ?? null };
        out.push({ in: input, out: view(vi) });
        n++;
      }
    }
  }
  return out;
}

/** Раздел `verdicts`: строка «Скована: …» по настоящей ковке (бросок в вилке, пол доводки). */
const verdictCases = () => craftedItems().map((c) => ({ name: c.name, item: noUid(c.item), ranges: c.ranges ?? null, floor: c.floor, text: rollVerdict(c.item, c.ranges, c.floor) }));

/** Раздел `enchant`: цена и ворота зачарования скованной вещи (окно гасит кнопку тем же правилом, что сервер). */
const enchantCases = () => craftedItems().map((c) => ({
  name: c.name, item: noUid(c.item),
  out: Object.fromEntries((['magic', 'rare'] as Rarity[]).map((r) => {
    const fit = enchantSlots(reg, c.item, r);
    return [r, {
      cost: num(enchantCost(reg, c.item, r)), essence: enchantMaterials(reg, c.item, r),
      fit: fit ? { slots: fit.slots, fillable: fit.fillable } : null, form: rolledFormMult(reg, c.item, r) ?? null,
    }];
  })),
}));

/** Раздел `costs`: «чего не хватает» и подпись цены (`craftMissing`, `describeCost`), место в сумке (`craftFits`). */
function costCases() {
  const out: unknown[] = [];
  const rng = createRng(55);
  for (const cls of ANAT_IDS()) for (const hands of familiesOf(reg, cls)) {
    const def = defaultParts(reg, cls, hands, rng.int(1, 5));
    if (!def) continue;
    const pv = craftWeapon(reg, { weaponClass: cls, hands, parts: def, finish: rng.int(0, 3) }, {});
    if (!pv.cost || !pv.item) continue;
    for (const [wn, wal] of Object.entries(WALLETS)) for (const gold of [0, pv.cost.gold - 1, pv.cost.gold]) {
      const lack = craftMissing(wal, gold, pv.cost);
      out.push({ cost: pv.cost, wallet: wn, gold, lack, text: describeCost(reg, lack.materials) });
    }
    for (const [bn, bag] of Object.entries(BAGS)) out.push({ fits: { bag: bn, materials: pv.cost.materials, gridW: pv.item.gridW, gridH: pv.item.gridH, out: craftFits(reg, bag, pv.cost.materials, pv.item) } });
  }
  return out;
}

/**
 * Раздел `reqs`: требования скованной вещи (`buildCraftShell` → `scaleReqs`: тир × скидка кузнеца, кап суммы наибольшим остатком, V-B2-03,
 * C-01) на синтетических требованиях — ничьи дробей (66.5/123.5), сумма ровно на капе, один и три атрибута, кап выключен.
 */
function reqCases() {
  const rng = createRng(19);
  const base = reg.get('items.base').find((b) => b.id === 'long-sword')!;
  const tiers = craftTiers(reg);
  const attrs = ['strength', 'dexterity', 'intelligence'] as const;
  const out: unknown[] = [];
  const sets: Record<string, number>[] = [{ strength: 14, dexterity: 26 }, { strength: 37, dexterity: 39 }, { strength: 25.04, dexterity: 25.04, intelligence: 25.84 }, { strength: 60 }, {}];
  for (let i = 0; i < 40; i++) {
    const r: Record<string, number> = {};
    for (const a of attrs) if (rng.chance(0.6)) r[a] = rng.int(4, 60) + (rng.chance(0.3) ? 0.5 : 0);
    sets.push(r);
  }
  for (const req of sets) for (const t of tiers) for (const d of [0, 0.2]) for (const cap of [190, 0, 150.5]) {
    const it = buildCraftShell({ ...base, requirements: req }, t, cap, { reqDiscount: d });
    out.push({ req, mult: t.reqMult * (1 - d), cap, out: it.requirements });
  }
  return out;
}

/** Раздел `host`: подпись заявки (одна сборка — один ключ) и заявка на провод (`wireInput`: только нужные поля). */
function hostCases() {
  const rng = createRng(8);
  const out: unknown[] = [];
  for (const cls of ANAT_IDS()) for (const hands of familiesOf(reg, cls)) {
    const input = randomInput(cls, hands, rng);
    const noFinish: CraftInput = { weaponClass: input.weaponClass, hands: input.hands, parts: input.parts };
    out.push({ input, sig: craftSig(input), wire: wireInput(input) }, { input: noFinish, sig: craftSig(noFinish), wire: wireInput(noFinish) });
  }
  return out;
}

/** Раздел `tooltips`: `describeItem` по вещам игры — каждая база любой редкости, ступени, сломанные, перекатанные, сырьё, эссенция, зелья. */
function tooltipCases() {
  const out: unknown[] = [];
  const bal = reg.get('balance');
  let seed = 600;
  const rarities = ['normal', 'magic', 'rare', 'unique'] as const;
  for (const [n, base] of reg.get('items.base').filter((b) => b.enabled !== false).entries()) {
    const it = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
      dropBias: 1, itemLevel: 5 + (n * 7) % 80, tierLevel: 5 + (n * 11) % 80, baseId: base.id, tiers: reg.get('item-tiers'), rarities: reg.get('rarities'),
      forceRarity: rarities[n % 4]!, maxReqTotal: bal.maxTotalRequirement, baseRoll: bal.loot.baseRoll, origin: 'drop',
    }, createRng(seed++));
    out.push(it);
    if (n % 5 === 0) out.push({ ...it, broken: true, rerolls: 2 });
  }
  for (const c of craftedItems()) out.push(c.item);
  out.push(materialItem(reg.get('craft-materials')[3]!, 17, 'mat-1'));
  // Стопка эссенции: «Валюта чар · в стеке 2», а не «Сырьё · …» (эссенция — не сырьё, валюта чар); имя — строкой выше, из конфига.
  out.push(materialItem(reg.get('craft-materials').find((m) => m.id === ESSENCE_ID)!, 2, 'mat-ess'));
  return out.map((it, i) => ({ item: noUid(it as Item), uid: `t-${i}`, out: tip(it as Item) }));
}

// ── вид оружия и хват ──────────────────────────────────────────────────────────────────────────────

/** Раздел `looks`: подпись руки (`weaponLookSig`) — по ней Unity просит GLB и кэширует модель. */
const lookCases = () => {
  const def = defaultParts(reg, 'sword', 1, 2)!;
  const hands: unknown[] = [
    { baseId: 'long-sword', parts: def },
    { baseId: 'claymore', parts: { strike: def.strike, grip: { id: 'x', step: 5 }, bind: def.bind, head: def.head } },
    { baseId: 'axe', parts: { strike: { id: 'a', step: 1 } } },
    { parts: def }, { baseId: 7, parts: null }, null, undefined, 'строка',
    { baseId: null, parts: { strike: { id: null, step: null }, grip: { id: 'g', step: 2 } } },
  ];
  return hands.map((h) => ({ hand: h ?? null, sig: weaponLookSig(h as never) }));
};

type GripSlot = { r: [number, number, number]; p: [number, number, number] };
const splitHands = (weapon: string): [string, string] => {
  const w = weapon === 'dual' ? 'sword+dagger' : weapon;
  const i = w.lastIndexOf('+');
  return i > 0 ? [w.slice(0, i), w.slice(i + 1)] : [w, 'none'];
};
/** Копия `loadGrip` (poseRuntime.ts): точный ключ → «рука одна» (`m` / `none+o`), легаси `offAlone.main`. */
function loadGrip(cfg: Record<string, Record<string, { main?: GripSlot; off?: GripSlot }>>, charId: string, weapon: string, fallbackId?: string): (GripSlot | null)[] {
  const slot = (k: string): { main?: GripSlot; off?: GripSlot } | undefined =>
    cfg[charId]?.[k] ?? (fallbackId ? cfg[fallbackId]?.[k] : undefined);
  const exact = slot(weapon);
  const [m, o] = splitHands(weapon);
  const mainAlone = m !== 'none' ? slot(m) : undefined;
  const offAlone = o !== 'none' ? slot('none+' + o) : undefined;
  return [
    exact?.main ?? mainAlone?.main ?? null,
    exact?.off ?? offAlone?.off ?? offAlone?.main ?? null,
  ];
}
/**
 * Группы рук по ключу оружия (копия `attachWeapons`): номер группы — контракт (0 — главная, 1 — вторая; пустая рука держит номер), кисть,
 * поворот хвата по умолчанию (эйлер XYZ three) и какая рука вида (`main`/`off`) ставит модель из деталей. Щит видом не бывает.
 */
function gripGroups(weapon: string): { kind: string; hand: string; rot: [number, number, number] | null; look: string | null }[] {
  const out: { kind: string; hand: string; rot: [number, number, number] | null; look: string | null }[] = [];
  const attach = (kind: string, hand: string, look: string | null): void => {
    if (kind === 'none') { out.push({ kind, hand, rot: null, look: null }); return; }
    const rot: [number, number, number] = kind === 'shield' ? [Math.PI / 2, 0, 0] : kind === 'bow' ? [0, 0, 0] : [-Math.PI / 2, 0, 0];
    out.push({ kind, hand, rot, look: kind !== 'shield' ? look : null });
  };
  let w = weapon;
  if (w === 'dual') w = 'sword+dagger';
  if (w === 'none') return out;
  const plus = w.lastIndexOf('+');
  if (plus > 0) { attach(w.slice(0, plus), 'RightHand', 'main'); attach(w.slice(plus + 1), 'LeftHand', 'off'); }
  else if (w === 'shield') attach('shield', 'LeftHand', null);
  else if (w === 'bow') attach('bow', 'LeftHand', 'main');
  else attach(w, 'RightHand', 'main');
  return out;
}
function gripCases() {
  const G = (n: number): GripSlot => ({ r: [-1.5 + n * 0.1, n * 0.05, -n * 0.02], p: [n * 0.3, -n * 0.2, n * 0.1] });
  const cfg = {
    warrior: { sword: { main: G(1) }, 'none+shield': { off: G(2) }, 'sword+shield': { off: G(3) }, greataxe: { main: G(4), off: G(5) }, 'none+dagger': { main: G(6) } },
    archer: { bow: { main: G(7) } },
    zombie: { axe: { main: G(8) } },
  };
  const keys = ['sword', 'sword+shield', 'sword+dagger', 'dual', 'axe', 'axe+shield', 'none+shield', 'shield', 'bow', 'greataxe', 'greataxe+shield', 'none+dagger', 'mace+dagger', 'none', 'staff', 'crossbow', 'halberd'];
  const out: unknown[] = [];
  for (const [charId, fb] of [['warrior', undefined], ['archer', undefined], ['zombie', 'warrior'], ['ghost', 'warrior'], ['ghost', undefined]] as const) {
    for (const k of keys) out.push({ charId, fallback: fb ?? null, weapon: k, grip: loadGrip(cfg, charId, k, fb), groups: gripGroups(k) });
  }
  return { cfg, cases: out };
}

describe('unityCraftGolden — продюсер эталона окна ковки (пишет __golden__/unity_craft.json)', () => {
  it('копии окна, хозяина, тултипа и хвата сторожатся строками исходника', () => {
    for (const [src, line] of SRC) expect(src.includes(line), `нет строки исходника: ${line}`).toBe(true);
  });

  it('генерит эталон и пишет на диск', () => {
    const families = familyCases();
    // Конфиг эталона обязан дать простой класса (V-B3-06), иначе порт Unity причину простоя не сверит.
    expect(families.some((f) => f.forgeable.length === 0), `простой класса (сняты: ${idleParts.join(', ')})`).toBe(true);
    expect(families.find((f) => f.cls === 'sword')!.forgeable).toEqual([1, 2]);
    const previews = previewCases() as { out: ReturnType<typeof previewOut> }[];
    const reasons = new Set(previews.map((p) => p.out.reason));
    // Каждый отказ ядра ковки, который бывает в окне, — хотя бы раз.
    const want = ['Нет такой детали', 'не для этого гнезда', 'не подходит этому семейству', 'куётся только из ступеней', 'не задаёт тип',
      'не открыт: разбери', 'ещё не открыта', 'не бывает выше', 'кузнец сейчас не куёт', 'Материал ещё не в игре'];
    // ⭐ D3: ворот ступени у ковки нет — отказов «Кузнец ещё не работал со ступенью…» и «Мифическую ступень кузнец откроет…» не бывает.
    expect([...reasons].some((r) => /не работал со ступенью|Мифическую ступень/.test(r ?? '')), 'ворота ступени').toBe(false);
    for (const w of want) expect([...reasons].some((r) => r?.includes(w)), `отказ «${w}»`).toBe(true);
    expect(previews.filter((p) => p.out.ok).length, 'собранных предпросмотров').toBeGreaterThan(200);
    expect(previews.some((p) => p.out.bake && (p.out.bake.notes as string[]).length > 0), 'оговорки запекания').toBe(true);
    expect(previews.some((p) => p.out.cost && (p.out.cost as { finish?: unknown }).finish), 'доводка в цене').toBe(true);
    const views = viewCases() as { out: ReturnType<typeof view> }[];
    expect(views.some((v) => v.out.sketch && (v.out.sketch as { confirm?: string }).confirm), 'эскиз к подтверждению').toBe(true);
    expect(views.some((v) => (v.out.left.craft as { title: string | null }).title === 'Нет места в сумке'), 'нет места в сумке').toBe(true);
    expect(views.some((v) => ((v.out.left.enchant as { disabled: boolean }[] | undefined) ?? []).some((e) => !e.disabled)), 'зачарование доступно').toBe(true);
    const golden = {
      note: 'Эталон паритета Unity ↔ веб окна ковки (U6c). Генерит packages/client/src/modules/town/unityCraftGolden.gen.test.ts.',
      config: {
        rarities: reg.get('rarities').map((r) => pick(r, ['id', 'priceMult', 'minAffixes', 'maxAffixes', 'maxPrefix', 'maxSuffix'])),
        'craft-materials': reg.get('craft-materials'),
        'items.base': reg.get('items.base'),
        'item-tiers': reg.get('item-tiers'),
        'weapon-parts': reg.get('weapon-parts'),
        'weapon-anatomy': reg.get('weapon-anatomy'),
        'weapon-types': reg.get('weapon-types'),
        'weapon-weights': reg.get('weapon-weights'),
        'armor-classes': reg.get('armor-classes'),
        'phys-subtypes': reg.get('phys-subtypes'),
        'magic-subtypes': reg.get('magic-subtypes'),
        'damage-kinds': reg.get('damage-kinds'),
        debuffs: reg.get('debuffs').map((d) => pick(d, ['id', 'name', 'icon'])),
        affixes: reg.get('affixes').map((a) => pick(a, ['id', 'enabled', 'kind', 'group', 'onMagic', 'onRare', 'appliesTo', 'exclude', 'stat', 'tiers', 'mods', 'proc'])),
        'skill-tree': { nodes: reg.get('skill-tree').nodes.map((n) => pick(n, ['id', 'name'])) },
        balance: (() => {
          const b = reg.get('balance');
          return {
            craft: b.craft, loot: { baseRoll: b.loot.baseRoll }, maxTotalRequirement: b.maxTotalRequirement,
            forgePrices: { upgradeReqDiscount: b.forgePrices.upgradeReqDiscount }, inventory: b.inventory,
          };
        })(),
      },
      journals: { ...JOURNALS, ...INIT_JOURNALS },
      wallets: WALLETS,
      bags: BAGS,
      families,
      parts: partCases(),
      bases: baseLines(),
      finish: finishCases(),
      previews,
      states: stateCases(),
      views,
      verdicts: verdictCases(),
      enchant: enchantCases(),
      costs: costCases(),
      host: hostCases(),
      reqs: reqCases(),
      tooltips: tooltipCases(),
      looks: lookCases(),
      grip: gripCases(),
      startClass: ANAT_IDS().concat(['no-such', '']).map((cls) => {
        const ok = (c: string | undefined): c is string => !!c && !!anatomyOf(reg, c) && forgeableFamilies(reg, c).length > 0;
        return { cls, out: ok(cls) ? cls : ok('sword') ? 'sword' : reg.get('weapon-anatomy').map((a) => a.id).find(ok) ?? 'sword' };
      }),
    };
    const dir = join(HERE, '__golden__');
    mkdirSync(dir, { recursive: true });
    // uid вещей, рождённых часами (uuidv7), — постоянными по порядку появления: эталон не должен меняться от прогона к прогону.
    const uids = new Map<string, string>();
    const stable = (k: string, v: unknown): unknown => {
      if (k !== 'uid' || typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(v)) return v;
      if (!uids.has(v)) uids.set(v, `u-${uids.size}`);
      return uids.get(v);
    };
    writeFileSync(join(dir, 'unity_craft.json'), JSON.stringify(golden, stable));
  });
});
