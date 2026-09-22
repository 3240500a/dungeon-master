import {
  CRAFT_SLOT_LIST, anatomyOf, craftSalvageYield, craftTiers, createRng, emptyJournal, familiesOf, fullJournal, generateItem,
  partById, partsOf, rollTierLevel, salvageIntoJournal, sketchable, slotName, tierIndexOfItem, typeOfItem, typeReach,
  typesRow, useSketch, variantsFor,
  type ConfigRegistry,
} from '@dm/shared';
import type { CraftSandbox } from './craft.js';

/**
 * «📖 Каталог и разбор» — петля открытия (docs/CRAFT_WEAPONS.md §12), каталог деталей «6 из 8»
 * и КОДЕКС ТИПОВ: исторические имена, которые игрок видел и сковал, и чего не хватает до остальных.
 *
 * ⭐ Главная петля системы — не «сковал оружие раз в двадцать уровней», а «разбор хлама кормит
 * каталог». Здесь её можно прогнать руками: нарезать дроп реальным генератором, разобрать, увидеть,
 * что открылось, сколько сырья пришло и когда выпал эскиз.
 */

const h = (tag: string, css: string, html = ''): HTMLElement => { const e = document.createElement(tag); e.style.cssText = css; if (html) e.innerHTML = html; return e; };
const BTN = 'padding:5px 10px;cursor:pointer;border-radius:5px;border:1px solid #3a3a4c;background:#1c1c26;color:#e8e8f0;font-size:12px';
const RARITY_HEX: Record<string, string> = { normal: '#d8d2c2', magic: '#6f9bcf', rare: '#dca94b', unique: '#c9702e' };
const DOT: Record<string, string> = { common: '#8f897c', uncommon: '#6f9bcf', rare: '#dca94b' };
const ORDER = ['sword', 'dagger', 'axe', 'mace', 'spear', 'halberd', 'bow', 'crossbow', 'wand', 'staff'];

export function renderCraftCatalog(main: HTMLElement, reg: ConfigRegistry, sb: CraftSandbox, rerender: () => void): void {
  if (sb.fullJournal) {
    main.append(h('div', 'background:#2a2416;border:1px solid #6b5418;border-radius:8px;padding:10px;font-size:12px;margin-bottom:12px;color:#e8d8a8',
      '⚠ Включено «Журнал: всё открыто» — каталог и кодекс показывают всё. Сними галку слева, чтобы открывать типы и детали разбором.'));
  }
  const j = sb.journal;
  const tiers = craftTiers(reg);
  const typeName = (cls: string, id: string): string => typesRow(reg, cls)?.names.find((r) => r.id === id)?.name ?? id;

  // ── Дроп и разбор ──
  const loop = h('div', 'background:#15151d;border:1px solid #2c2c3a;border-radius:8px;padding:10px;font-size:12px;margin-bottom:12px');
  loop.append(h('div', 'color:#e39a3c;font-weight:600;margin-bottom:6px', 'Нарезать дроп → разобрать у кузнеца'));
  const row = h('div', 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px');
  const roll = (n: number): void => {
    const rng = createRng(sb.seed++ * 7717);
    const bal = reg.get('balance');
    for (let i = 0; i < n; i++) {
      const it = generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
        dropBias: 1, itemLevel: sb.level, tierLevel: rollTierLevel(sb.level, bal.loot.tierWindow, rng), categoryWeights: { weapon: 1 },
        tiers: reg.get('item-tiers'), rarities: reg.get('rarities'), rareNames: reg.get('rare-names'), maxReqTotal: bal.maxTotalRequirement,
        baseRoll: bal.loot.baseRoll,
      }, rng);
      if (it.kind === 'weapon' && it.rarity !== 'unique') sb.drops.push(it);
    }
    rerender();
  };
  for (const n of [10, 50, 200]) { const b = h('button', BTN, `Нарезать ×${n}`); b.addEventListener('click', () => roll(n)); row.append(b); }
  const salv = h('button', `${BTN};border-color:#e39a3c`, `Разобрать всё (${sb.drops.length})`);
  (salv as HTMLButtonElement).disabled = !sb.drops.length;
  salv.addEventListener('click', () => {
    let opened = 0, sketches = 0, types = 0; const mats: Record<string, number> = {};
    for (const it of sb.drops) {
      const r = salvageIntoJournal(reg, sb.journal, it);
      sb.journal = r.journal;
      opened += r.unlocked.length; if (r.sketch) sketches++;
      const cls = reg.get('items.base').find((b) => b.id === it.baseId && b.kind === 'weapon') as { weaponClass: string } | undefined;
      if (r.unlocked.length) sb.log.unshift(`${it.name} → открыто: ${r.unlocked.map((id) => partById(reg, id)?.name ?? id).join(', ')}${r.newBase ? ' · новый тип' : ''}`);
      if (r.newType && cls) { types++; sb.log.unshift(`📜 Кодекс: ${typeName(cls.weaponClass, r.newType)}`); }
      if (r.sketch) sb.log.unshift(`✦ Эскиз за ${reg.get('balance').craft.journal.sketchAfter} разборов класса`);
      if (r.tierUp) sb.log.unshift(`▲ Потолок ступени: ${tiers[sb.journal.tierHi]?.id} ${tiers[sb.journal.tierHi]?.name}`);
      for (const [id, n] of Object.entries(craftSalvageYield(reg, it))) { mats[id] = (mats[id] ?? 0) + n; sb.wallet[id] = (sb.wallet[id] ?? 0) + n; }
    }
    const name = (id: string): string => reg.get('craft-materials').find((m) => m.id === id)?.name ?? id;
    sb.log.unshift(`Разобрано ${sb.drops.length}: открыто деталей ${opened}, типов в кодексе ${types}, эскизов ${sketches}. Сырьё: ${Object.entries(mats).map(([id, n]) => `${name(id)} ×${n}`).join(', ')}`);
    sb.log = sb.log.slice(0, 60);
    sb.drops = [];
    rerender();
  });
  const reset = h('button', BTN, 'Сбросить журнал');
  reset.addEventListener('click', () => { sb.journal = emptyJournal(); sb.log = []; sb.drops = []; rerender(); });
  row.append(salv, reset);
  loop.append(row);
  loop.append(h('div', 'color:#888;font-size:11px;margin-bottom:6px', `Дроп — реальный генератор на уровне героя (${sb.level}), только оружие, уникальные не разбираются. Детали вещи и их материалы выводятся из неё самой — разбор их открывает, а не катает, и отдаёт ровно те материалы, из которых вещь сделана. Сырьё уходит в кошелёк песочницы.`));

  if (sb.drops.length) {
    const list = h('div', 'max-height:220px;overflow-y:auto;border-top:1px solid #2c2c3a;padding-top:6px');
    for (const it of sb.drops.slice(0, 200)) {
      const p = partsOf(reg, it);
      const t = tiers[tierIndexOfItem(reg, it)];
      const type = typeOfItem(reg, it);
      const parts = p ? CRAFT_SLOT_LIST.map((s) => { const v = partById(reg, p[s].id); const fresh = !j.variants.includes(p[s].id); return `<span style="color:${fresh ? '#e39a3c' : '#999'}">${v?.name ?? p[s].id} <span style="color:#666">ст.${p[s].step}</span>${fresh ? ' ★' : ''}</span>`; }).join(' · ') : '';
      list.append(h('div', 'padding:2px 0;font-size:12px', `<span style="color:${RARITY_HEX[it.rarity]}">${it.name}</span> <span style="color:#777">${t?.id ?? ''} · тип: ${type?.name ?? '—'}</span><br><span style="font-size:11px">${parts}</span>`));
    }
    loop.append(list);
  }
  main.append(loop);

  // ── Журнал ──
  const jr = h('div', 'background:#15151d;border:1px solid #2c2c3a;border-radius:8px;padding:10px;font-size:12px;margin-bottom:12px');
  const allBases = reg.get('items.base').filter((b) => b.kind === 'weapon').length;
  const allVar = reg.get('weapon-parts').length;
  const allTypes = reg.get('weapon-types').reduce((s, r) => s + r.names.filter((n) => n.enabled !== false).length, 0);
  const mythicNeed = reg.get('balance').craft.journal.mythicSalvages;
  jr.append(h('div', 'color:#e39a3c;font-weight:600;margin-bottom:6px', 'Журнал кузнеца'));
  jr.append(h('div', 'line-height:1.7', `Типов (баз): <b>${j.bases.length}</b> / ${allBases} · деталей: <b>${j.variants.length}</b> / ${allVar} · кодекс: видел <b>${j.typesSeen.length}</b>, сковал <b>${j.typesForged.length}</b> / ${allTypes} · потолок ступени: <b>${j.tierHi >= 0 ? `${tiers[j.tierHi]?.id} ${tiers[j.tierHi]?.name}` : '—'}</b> · мифических разобрано: <b>${j.mythic}</b> / ${mythicNeed} для t6 · эскизов: <b>${j.sketches}</b>`));
  if (j.sketches > 0) {
    const sel = document.createElement('select'); sel.style.cssText = 'padding:4px 7px;background:#0f0f16;color:#e8e8f0;border:1px solid #2c2c3a;border-radius:4px;font-size:12px;margin-right:6px';
    for (const p of reg.get('weapon-parts').filter((x) => sketchable(reg, j, x.id))) { const o = document.createElement('option'); o.value = p.id; o.textContent = `${p.name} (${p.classes.join(', ')})`; sel.append(o); }
    const use = h('button', BTN, 'Потратить эскиз');
    use.addEventListener('click', () => { sb.journal = useSketch(reg, sb.journal, sel.value); sb.log.unshift(`✦ Эскиз → ${partById(reg, sel.value)?.name}`); rerender(); });
    const r = h('div', 'margin-top:6px'); r.append(sel, use); jr.append(r);
    jr.append(h('div', 'color:#777;font-size:11px;margin-top:4px', 'Эскиз не открывает ключевую форму неоткрытого типа: типы открываются только разбором.'));
  }
  if (sb.log.length) {
    const lg = h('div', 'margin-top:8px;max-height:140px;overflow-y:auto;font-size:11px;color:#bbb;border-top:1px solid #2c2c3a;padding-top:6px');
    for (const l of sb.log) lg.append(h('div', 'padding:1px 0', l));
    jr.append(lg);
  }
  main.append(jr);

  const view = sb.fullJournal ? { ...fullJournal(reg), typesSeen: j.typesSeen, typesForged: j.typesForged } : j;

  // ── Кодекс типов ──
  const codex = h('div', 'background:#15151d;border:1px solid #2c2c3a;border-radius:8px;padding:10px;font-size:12px;margin-bottom:12px');
  codex.append(h('div', 'color:#e39a3c;font-weight:600;margin-bottom:4px', '📜 Кодекс типов'));
  codex.append(h('div', 'color:#888;font-size:11px;margin-bottom:8px', 'Исторические имена из классификатора (`weapon-types`). ✓ — сковал, 👁 — видел на разобранной вещи, ◇ — можно собрать из открытого, 🔒 — не хватает деталей. Ни одного числа имя не даёт — это коллекция.'));
  const cg = h('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px');
  for (const cls of ORDER) {
    const row2 = typesRow(reg, cls);
    const anat = anatomyOf(reg, cls);
    if (!row2 || !anat) continue;
    const c = h('div', 'border:1px solid #23232f;border-radius:6px;padding:6px 8px');
    const rules = row2.names.filter((r) => r.enabled !== false);
    const done = rules.filter((r) => view.typesForged.includes(r.id)).length;
    c.append(h('div', 'display:flex;justify-content:space-between;margin-bottom:4px', `<b>${anat.name}</b><span style="color:#999">${done} из ${rules.length}</span>`));
    for (const r of rules) {
      const forged = view.typesForged.includes(r.id), seen = view.typesSeen.includes(r.id);
      const reach = typeReach(reg, view, cls, r);
      const mark = forged ? '✓' : seen ? '👁' : reach.available ? '◇' : '🔒';
      const col = forged ? '#8aa84a' : seen ? '#dca94b' : reach.available ? '#ddd' : '#555';
      const line = h('div', `font-size:11.5px;color:${col};padding:1px 0`, `${mark} ${r.name.replace(/\{[^}]+\}/g, '…')}`);
      line.title = [r.subtitle, r.fantasy ? 'фэнтези' : r.source, reach.available ? '' : `не хватает — ${reach.missing.join('; ')}`].filter(Boolean).join('\n');
      c.append(line);
    }
    cg.append(c);
  }
  codex.append(cg);
  main.append(codex);

  // ── Каталог деталей ──
  const cat = h('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:10px');
  for (const cls of ORDER) {
    const anat = anatomyOf(reg, cls);
    if (!anat) continue;
    const hands = familiesOf(reg, cls);
    const c = h('div', 'background:#15151d;border:1px solid #2c2c3a;border-radius:8px;padding:8px;font-size:12px');
    let open = 0, total = 0;
    const grid = h('div', 'display:grid;grid-template-columns:repeat(4,1fr);gap:6px');
    for (const s of CRAFT_SLOT_LIST) {
      const col = h('div', '');
      const vs = variantsFor(reg, cls, s);
      const o = vs.filter((v) => view.variants.includes(v.id)).length;
      open += o; total += vs.length;
      col.append(h('div', 'color:#e39a3c;font-size:11px;margin-bottom:2px', `${slotName(anat, s, hands[0] ?? 1)}${s === anat.keySlot ? ' ★' : ''} ${o}/${vs.length}`));
      for (const v of vs) {
        const on = view.variants.includes(v.id);
        col.append(h('div', `font-size:11px;color:${on ? '#ddd' : '#4a4a4a'};display:flex;gap:4px;align-items:center`, `<span style="width:6px;height:6px;border-radius:50%;background:${on ? DOT[v.rarity] : '#2a2a2a'};flex:none"></span>${on ? v.name : '▒▒▒▒'}`));
      }
      grid.append(col);
    }
    c.append(h('div', 'display:flex;justify-content:space-between;margin-bottom:6px', `<b>${anat.name}</b><span style="color:${open === total ? '#8aa84a' : '#999'}">${open} из ${total}</span>`));
    c.append(grid);
    cat.append(c);
  }
  main.append(cat);
}
