import { ConfigRegistry, generateItem, pickTierClamped, createRng, type Item, type Rarity, type StatModifier } from '@dm/shared';

/**
 * Вкладка «Генератор предметов» (песочница дропа): выбираешь базу + уровень (+редкость/MF),
 * жмёшь «Ролл» — движок игры (generateItem) катает предмет на ТЕКУЩЕМ (правленом) конфиге.
 * Одиночный ролл показывает карточку как в игре; пакетный (N роллов) — распределение редкостей/
 * тиров и частоту аффиксов (для баланса). Правишь базы/аффиксы на других вкладках → сюда → видишь.
 */
function regFromData(data: Record<string, unknown>): ConfigRegistry {
  const reg = new ConfigRegistry();
  reg.loadAll(data);
  return reg;
}

// ── состояние (переживает перерисовку) ──────────────────────────────────────
let baseId = '';                 // '' = случайная база (по весам категорий)
let itemLevel = 40;
let forceRarity: '' | Rarity = ''; // '' = натуральный ролл
let dropBias = 1;
let seed = 1;
let batch = 1;                   // 1 — одиночная карточка; >1 — распределение

// ── подписи статов (коротко; неизвестный → сырой ключ) ──────────────────────
const STAT_LABEL: Record<string, string> = {
  minDamage: 'мин. урон', maxDamage: 'макс. урон', armor: 'броня', maxHp: 'HP', maxMana: 'мана',
  attackSpeed: 'скор. атаки', moveSpeed: 'скор. бега', critChance: 'крит', accuracy: 'точность', evade: 'уклонение', blockChance: 'блок',
  strength: 'сила', dexterity: 'ловкость', intelligence: 'интеллект', vitality: 'живучесть',
  resFire: 'сопр. огню', resCold: 'сопр. холоду', resLightning: 'сопр. молнии', resPoison: 'сопр. яду',
  addFire: 'урон огнём', addCold: 'урон холодом', addLightning: 'урон молнией', addPoison: 'урон ядом',
  damagePct: '% ко всему урону', physPct: '% к физ. урону', firePct: '% к огню', coldPct: '% к холоду', lightningPct: '% к молнии', poisonPct: '% к яду',
  lifeLeechPct: 'вампиризм жизни', manaLeechPct: 'вампиризм маны', lifeOnKill: 'жизнь за убийство', manaOnKill: 'мана за убийство',
  hpRegen: 'реген HP', manaRegen: 'реген маны',
};
const PERCENT = new Set(['critChance', 'blockChance', 'resFire', 'resCold', 'resLightning', 'resPoison', 'damagePct', 'physPct', 'firePct', 'coldPct', 'lightningPct', 'poisonPct', 'lifeLeechPct', 'manaLeechPct']);
const fmtStat = (m: StatModifier): string => {
  const label = STAT_LABEL[m.stat] ?? m.stat;
  if (m.kind === 'increased' || PERCENT.has(m.stat)) return `+${Math.round(m.value * 100)}% ${label}`;
  return `+${Number.isInteger(m.value) ? m.value : m.value.toFixed(2)} ${label}`;
};

const h = (tag: string, css: string, html = ''): HTMLElement => { const e = document.createElement(tag); e.style.cssText = css; if (html) e.innerHTML = html; return e; };

export function renderItemGenPage(page: HTMLElement, data: Record<string, unknown>): void {
  page.innerHTML = '';
  const reg = regFromData(data);
  const bases = reg.get('items.base');
  const rarities = reg.get('rarities');
  const tiers = reg.get('item-tiers');
  const nodes = reg.get('skill-tree').nodes;
  const skillName = (id: string): string => nodes.find((n) => n.id === id)?.name ?? id;
  const rarityColor = (id: string): string => rarities.find((r) => r.id === id)?.color ?? '#c8c8c8';
  const baseById = (id: string): (typeof bases)[number] | undefined => bases.find((b) => b.id === id);

  page.appendChild(h('div', 'font-size:15px;font-weight:600;color:#e8e8f0;margin:2px 0 12px', '🎲 Генератор предметов (песочница дропа)'));

  // ── контролы ──────────────────────────────────────────────────────────────
  const bar = h('div', 'display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:14px');
  const field = (label: string, ctrl: HTMLElement): HTMLElement => {
    const w = h('label', 'display:flex;flex-direction:column;gap:3px;font-size:12px;color:#9a9aac');
    w.append(document.createTextNode(label), ctrl); return w;
  };
  const inputCss = 'background:#14141c;border:1px solid #2c2c3a;border-radius:5px;color:#e8e8f0;padding:5px 7px;font-size:13px';

  const baseSel = h('select', inputCss + ';min-width:220px') as HTMLSelectElement;
  baseSel.append(new Option('🎲 Случайная (по весам)', ''));
  const byKind: Record<string, typeof bases> = {};
  for (const b of bases) (byKind[b.kind] ??= []).push(b);
  const kindLabel: Record<string, string> = { weapon: 'Оружие', armor: 'Броня', shield: 'Щиты', jewelry: 'Украшения', consumable: 'Расходники' };
  for (const [kind, arr] of Object.entries(byKind)) {
    const og = document.createElement('optgroup'); og.label = kindLabel[kind] ?? kind;
    for (const b of arr) og.append(new Option(`${b.name} (${b.id})`, b.id));
    baseSel.append(og);
  }
  baseSel.value = baseId;
  baseSel.addEventListener('change', () => { baseId = baseSel.value; run(); });

  const lvlInp = h('input', inputCss + ';width:70px') as HTMLInputElement;
  lvlInp.type = 'number'; lvlInp.min = '1'; lvlInp.max = '100'; lvlInp.value = String(itemLevel);
  lvlInp.addEventListener('change', () => { itemLevel = Math.max(1, Math.min(100, Number(lvlInp.value) || 1)); run(); });

  const rarSel = h('select', inputCss) as HTMLSelectElement;
  rarSel.append(new Option('как выпадет', ''));
  for (const r of rarities) rarSel.append(new Option(r.name, r.id));
  rarSel.value = forceRarity;
  rarSel.addEventListener('change', () => { forceRarity = rarSel.value as '' | Rarity; run(); });

  const mfInp = h('input', inputCss + ';width:70px') as HTMLInputElement;
  mfInp.type = 'number'; mfInp.min = '0.5'; mfInp.max = '10'; mfInp.step = '0.5'; mfInp.value = String(dropBias);
  mfInp.addEventListener('change', () => { dropBias = Math.max(0.1, Number(mfInp.value) || 1); run(); });

  const batchSel = h('select', inputCss) as HTMLSelectElement;
  for (const n of [1, 100, 1000, 5000]) batchSel.append(new Option(n === 1 ? 'одиночный' : `${n} (распределение)`, String(n)));
  batchSel.value = String(batch);
  batchSel.addEventListener('change', () => { batch = Number(batchSel.value); run(); });

  const rollBtn = h('button', inputCss + ';cursor:pointer;background:#274032;border-color:#3a5a44;font-weight:600', '↻ Ролл');
  rollBtn.addEventListener('click', () => { seed = (seed + 1) & 0xffffff; run(); });

  bar.append(field('База', baseSel), field('Уровень', lvlInp), field('Редкость', rarSel), field('Magic Find', mfInp), field('Кол-во', batchSel), field(' ', rollBtn));
  page.appendChild(bar);

  const out = h('div', '');
  page.appendChild(out);

  // ── ролл ────────────────────────────────────────────────────────────────
  const rollOne = (s: number): Item => generateItem(reg.get('items.base'), reg.get('affixes'), reg.get('uniques'), {
    dropBias, itemLevel, baseId: baseId || undefined, tiers, rarities, rareNames: reg.get('rare-names'),
    categoryWeights: reg.get('balance').loot.categoryWeights, forceRarity: forceRarity || undefined,
  }, createRng(s));

  const tierName = (item: Item): string => {
    const b = baseById(item.baseId); if (!b) return '—';
    return pickTierClamped(tiers, item.itemLevel, b.minTier, b.maxTier)?.name ?? 'Сломанный';
  };

  function card(item: Item): HTMLElement {
    const b = baseById(item.baseId);
    const col = rarityColor(item.rarity);
    const box = h('div', `border:1px solid ${col};border-radius:8px;padding:12px 14px;background:#14141c;max-width:460px`);
    box.appendChild(h('div', `color:${col};font-weight:700;font-size:15px`, item.name));
    const meta = [`${rarities.find((r) => r.id === item.rarity)?.name ?? item.rarity}`, `тир: ${tierName(item)}`, `ур.предмета ${item.itemLevel}`];
    if (b) meta.push(kindLabel[b.kind] ?? b.kind);
    box.appendChild(h('div', 'color:#8a8a9a;font-size:11px;margin:2px 0 8px', meta.join(' · ')));
    for (const m of item.baseStats) box.appendChild(h('div', 'color:#cfd0da;font-size:12px', fmtStat(m)));
    for (const a of item.affixes) {
      if (a.modifier) box.appendChild(h('div', 'color:#7fa7d8;font-size:12px', fmtStat(a.modifier)));
      else if (a.proc) box.appendChild(h('div', 'color:#c99a48;font-size:12px', `${Math.round(a.proc.chance * 100)}% скаст «${skillName(a.proc.skillId)}» (ур.${a.proc.level}) ${a.proc.trigger === 'struck' ? 'при получении удара' : 'при ударе'}`));
    }
    const reqs = Object.entries(item.requirements);
    if (reqs.length) box.appendChild(h('div', 'color:#8a8a9a;font-size:11px;margin-top:6px', 'Требует: ' + reqs.map(([k, v]) => `${STAT_LABEL[k] ?? k} ${v}`).join(', ')));
    return box;
  }

  function distTable(title: string, rows: [string, number, string?][], total: number): HTMLElement {
    const box = h('div', 'margin:0 18px 14px 0;min-width:220px;vertical-align:top;display:inline-block');
    box.appendChild(h('div', 'color:#b8b8c8;font-weight:600;font-size:13px;margin-bottom:5px', title));
    for (const [label, n, color] of rows) {
      const pct = total ? (n / total * 100) : 0;
      const row = h('div', 'display:flex;align-items:center;gap:8px;font-size:12px;margin:2px 0');
      row.append(
        h('div', `width:130px;color:${color ?? '#cfd0da'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`, label),
        h('div', `flex:0 0 44px;text-align:right;color:#8a8a9a`, `${pct.toFixed(1)}%`),
        h('div', `flex:0 0 40px;text-align:right;color:#6a6a7a`, String(n)),
      );
      box.appendChild(row);
    }
    return box;
  }

  function run(): void {
    out.innerHTML = '';
    if (batch <= 1) {
      out.appendChild(card(rollOne(seed)));
      return;
    }
    // пакет: катаем batch раз (сиды seed..seed+batch-1), агрегируем
    const rar: Record<string, number> = {}, tier: Record<string, number> = {}, aff: Record<string, number> = {};
    let affSum = 0;
    for (let i = 0; i < batch; i++) {
      const it = rollOne((seed + i) & 0xffffff);
      rar[it.rarity] = (rar[it.rarity] ?? 0) + 1;
      tier[tierName(it)] = (tier[tierName(it)] ?? 0) + 1;
      affSum += it.affixes.length;
      for (const a of it.affixes) aff[a.affixId] = (aff[a.affixId] ?? 0) + 1;
    }
    out.appendChild(h('div', 'color:#8a8a9a;font-size:12px;margin-bottom:10px', `${batch} роллов${baseId ? '' : ' (случайная база)'} · ур.${itemLevel} · MF ${dropBias} · средн. аффиксов ${(affSum / batch).toFixed(2)}`));
    const wrap = h('div', '');
    wrap.appendChild(distTable('Редкости', rarities.map((r) => [r.name, rar[r.id] ?? 0, r.color] as [string, number, string]).filter((x) => x[1] > 0), batch));
    wrap.appendChild(distTable('Тиры', tiers.map((t) => [t.name, tier[t.name] ?? 0] as [string, number]).filter((x) => x[1] > 0), batch));
    const topAff = Object.entries(aff).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([id, n]) => [id, n] as [string, number]);
    if (topAff.length) wrap.appendChild(distTable('Аффиксы (частота, топ-20)', topAff, batch));
    out.appendChild(wrap);
  }

  run();
}
