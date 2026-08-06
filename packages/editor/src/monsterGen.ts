import { ConfigRegistry, generateMonster, createRng, STAT_LABEL, PERCENT_STATS, type ScaledMonster, type MonsterGearRoll } from '@dm/shared';

/**
 * Вкладка «Генератор мобов» (песочница спавна) — зеркало генератора предметов: выбираешь монстра +
 * уровень (+чемпион), жмёшь «Ролл» — движок игры (generateMonster) деривит боевой стат-блок на ТЕКУЩЕМ
 * (правленом) конфиге из атрибутов+гира. Одиночный ролл — карточка стат-блока; пакет (N роллов) —
 * распределение редкости/аффиксов + средние hp/урон (для баланса). Правишь мобов/гир/тиры → сюда → видишь.
 * Редкость (normal/magic/rare) катает гир-афиксы item-движком (маппинг в статы) + чемпион ортогонально.
 */
function regFromData(data: Record<string, unknown>): ConfigRegistry {
  const reg = new ConfigRegistry();
  reg.loadAll(data);
  return reg;
}

let baseId = '';
let level = 5;
let rarity: 'normal' | 'magic' | 'rare' | 'unique' = 'normal';
let seed = 1;
let batch = 1;

const h = (tag: string, css: string, html = ''): HTMLElement => { const e = document.createElement(tag); e.style.cssText = css; if (html) e.innerHTML = html; return e; };
const DMG_SHORT: Record<string, string> = { physical: 'физ', fire: 'огонь', cold: 'холод', lightning: 'молния', poison: 'яд' };
const pctS = (x: number): string => `${Math.round(x * 100)}%`;

// Плавающий тултип со статами предмета (как у предметов игрока: база + афиксы).
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
/** Строка афикса как у предметов игрока: «+15% К физ. урону» / «+8 Броня» (STAT_LABEL + PERCENT_STATS). */
function fmtMod(m: { stat: string; kind: 'flat' | 'increased'; value: number }): string {
  const isPct = m.kind === 'increased' || PERCENT_STATS.has(m.stat);
  const v = isPct ? `+${Math.round(m.value * 100)}%` : `+${Number.isInteger(m.value) ? m.value : m.value.toFixed(2)}`;
  return `${v} ${STAT_LABEL[m.stat] ?? m.stat}`;
}

export function renderMonsterGenPage(page: HTMLElement, data: Record<string, unknown>): void {
  page.innerHTML = '';
  const reg = regFromData(data);
  const monsters = reg.get('monsters');
  const gear = reg.get('monster-gear');
  const affixes = reg.get('monster-affixes');
  const itemAffixes = reg.get('affixes');
  const rarities = reg.get('rarities');
  const gearName = (id: string): string => (id ? (gear.find((g) => g.id === id)?.name ?? id) : '—');
  const src = (id: string): (typeof monsters)[number] | undefined => monsters.find((m) => m.id === id);
  const rarName = (id: string): string => rarities.find((r) => r.id === id)?.name ?? id;
  const rarCol = (m: ScaledMonster): string => (m.rarity === 'champion' ? '#e0b040' : rarities.find((r) => r.id === m.rarity)?.color ?? '#c8c8c8');

  page.appendChild(h('div', 'font-size:15px;font-weight:600;color:#e8e8f0;margin:2px 0 12px', '👹 Генератор мобов (песочница спавна)'));

  const bar = h('div', 'display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:14px');
  const field = (labelText: string, ctrl: HTMLElement): HTMLElement => { const w = h('div', 'display:flex;flex-direction:column;gap:3px'); w.append(h('label', 'font-size:11px;color:#9aa', labelText), ctrl); return w; };
  const inp = 'padding:5px 8px;background:#0f0f16;color:#e8e8f0;border:1px solid #2c2c3a;border-radius:4px;font-size:13px';

  const monSel = document.createElement('select'); monSel.style.cssText = inp + ';min-width:180px';
  const rnd = document.createElement('option'); rnd.value = ''; rnd.textContent = '(случайный из пула)'; monSel.appendChild(rnd);
  for (const m of monsters) { const o = document.createElement('option'); o.value = m.id; o.textContent = `${m.name} [${m.tier}]`; if (m.id === baseId) o.selected = true; monSel.appendChild(o); }
  monSel.addEventListener('change', () => { baseId = monSel.value; run(); });

  const lvlInp = document.createElement('input'); lvlInp.type = 'number'; lvlInp.min = '1'; lvlInp.value = String(level); lvlInp.style.cssText = inp + ';width:70px';
  lvlInp.addEventListener('input', () => { level = Math.max(1, Number(lvlInp.value) || 1); run(); });

  const rarSel = document.createElement('select'); rarSel.style.cssText = inp;
  for (const [v, t] of [['normal', 'обычный'], ['magic', 'магический'], ['rare', 'редкий'], ['unique', 'уникальный']] as [typeof rarity, string][]) { const o = document.createElement('option'); o.value = v; o.textContent = t; if (v === rarity) o.selected = true; rarSel.appendChild(o); }
  rarSel.addEventListener('change', () => { rarity = rarSel.value as typeof rarity; run(); });

  const batchInp = document.createElement('input'); batchInp.type = 'number'; batchInp.min = '1'; batchInp.value = String(batch); batchInp.style.cssText = inp + ';width:70px';
  batchInp.addEventListener('input', () => { batch = Math.max(1, Number(batchInp.value) || 1); run(); });

  const rollBtn = document.createElement('button'); rollBtn.textContent = '🎲 Ролл'; rollBtn.style.cssText = inp + ';cursor:pointer;background:#2c2c3a;font-weight:600';
  rollBtn.addEventListener('click', () => { seed = (seed + 1) & 0xffffff; run(); });

  bar.append(field('Монстр', monSel), field('Уровень', lvlInp), field('Редкость', rarSel), field('Кол-во', batchInp), field(' ', rollBtn));
  page.appendChild(bar);

  const out = h('div', ''); page.appendChild(out);

  const mderive = reg.get('monster-derive');
  const monsterRarity = reg.get('monster-rarity');
  const monsterUniques = reg.get('monster-uniques');
  const rollOne = (s: number): ScaledMonster =>
    generateMonster(monsters, gear, affixes, { baseId: baseId || undefined, depth: level - 1, mderive, itemAffixes, rarities, rarity, monsterRarity, monsterUniques, randomChampion: false }, createRng(s));
  const SLOT_RU: Record<string, string> = { weapon: 'Оружие', armor: 'Броня', helm: 'Шлем', shield: 'Щит' };
  const rarColOf = (r: string): string => (r === 'champion' ? '#e0b040' : rarities.find((x) => x.id === r)?.color ?? '#c8c8c8');

  function row(k: string, v: string): HTMLElement { const r = h('div', 'display:flex;justify-content:space-between;gap:14px;font-size:12px;margin:2px 0'); r.append(h('span', 'color:#8a8a9a', k), h('span', 'color:#eaeaea;text-align:right', v)); return r; }

  function card(m: ScaledMonster): HTMLElement {
    const col = rarCol(m); const s = src(m.id);
    const box = h('div', `border:1px solid ${col};border-radius:8px;padding:12px 14px;background:#14141c;max-width:440px`);
    box.appendChild(h('div', `color:${col};font-weight:700;font-size:15px`, m.name));
    box.appendChild(h('div', 'color:#8a8a9a;font-size:11px;margin:1px 0 8px', `${m.rarity === 'champion' ? 'Чемпион' : rarName(m.rarity)} · тир ${s?.tier ?? '—'} · ${m.faction} · роль ${s?.role ?? '—'} · ур.${m.level}`));
    box.appendChild(row('HP', `${m.hp}${m.hpRegen ? ` (+${m.hpRegen}/с)` : ''}`));
    box.appendChild(row('Урон', `${m.minDamage}–${m.maxDamage} ${DMG_SHORT[m.damageType] ?? m.damageType}${m.physSub ? ` · ${m.physSub}` : ''}`));
    box.appendChild(row('Меткость / Уворот / Армор', `${m.accuracy} / ${m.evade} / ${m.armor}`));
    box.appendChild(row('Блок / Крит / Скор.атаки', `${pctS(m.blockChance)} / ${pctS(m.critChance)}×${m.critMultiplier} / ${m.attackSpeed.toFixed(2)}`));
    box.appendChild(row('Скорость / AI', `${m.moveSpeed} / ${m.ai}`));
    box.appendChild(row('Зрение / Слух', `${m.vision} (${m.visionAngle}°) / ${m.hearing}`));
    box.appendChild(row('Резисты (О/Х/М/Я)', `${pctS(m.resFire)} / ${pctS(m.resCold)} / ${pctS(m.resLightning)} / ${pctS(m.resPoison)}`));
    box.appendChild(row('XP', String(m.xp)));
    // Гир по 4 слотам: имя предмета в цвете его редкости + афиксы; наведи = полный тултип со статами.
    if (m.gearRolls?.length) {
      box.appendChild(h('div', 'color:#8a8a9a;font-size:11px;margin:8px 0 3px;text-transform:uppercase;letter-spacing:.04em', 'Экипировка'));
      const gearTip = (g: MonsterGearRoll): string => {
        const col = rarColOf(g.rarity), b = g.base;
        const lines = [`<div style="color:${col};font-weight:600;margin-bottom:4px">${g.name}</div>`];
        if (b.minDamage != null) lines.push(`<div style="color:#dcdce4">Урон ${b.minDamage}–${b.maxDamage} ${DMG_SHORT[b.damageType ?? 'physical'] ?? b.damageType}</div>`);
        if (b.attackSpeed != null) lines.push(`<div style="color:#9aa">Скор. атаки ${b.attackSpeed}</div>`);
        if (b.defense) lines.push(`<div style="color:#dcdce4">Защита +${b.defense}</div>`);
        if (b.block != null) lines.push(`<div style="color:#dcdce4">Блок ${pctS(b.block)}</div>`);
        for (const mod of g.mods) lines.push(`<div style="color:${col}">${fmtMod(mod)}</div>`);
        if (g.rarity === 'normal' && !g.mods.length) lines.push('<div style="color:#8a8a9a;font-size:11px">обычный, без афиксов</div>');
        return lines.join('');
      };
      for (const g of m.gearRolls) {
        const gr = h('div', 'font-size:12px;margin:2px 0;line-height:1.4;cursor:help');
        gr.innerHTML = `<span style="color:#8a8a9a">${SLOT_RU[g.slot] ?? g.slot}:</span> <span style="color:${rarColOf(g.rarity)}">${g.name}</span>` +
          (g.affixes.length ? ` <span style="color:${rarColOf(g.rarity)};font-size:11px">[${g.affixes.join(', ')}]</span>` : '');
        gr.addEventListener('mousemove', (e) => showTip(gearTip(g), (e as MouseEvent).clientX, (e as MouseEvent).clientY));
        gr.addEventListener('mouseleave', hideTip);
        box.appendChild(gr);
      }
    } else {
      box.appendChild(row('Оружие / Броня / Щит', `${gearName(s?.weapon ?? '')} / ${gearName(s?.armor ?? '')} / ${gearName(s?.offhand ?? '')}`));
    }
    // Все афиксы гира одним списком (быстрый обзор всего, что накатано на монстра).
    const allAff = (m.gearRolls ?? []).flatMap((g) => g.affixes);
    if (allAff.length) box.appendChild(h('div', `font-size:11px;margin-top:8px;color:${col};line-height:1.5`, `<b>Афиксы гира (${allAff.length}):</b> ${allAff.join(', ')}`));
    return box;
  }

  function distTable(title: string, rows: [string, number][], total: number): HTMLElement {
    const box = h('div', 'margin:0 18px 14px 0;min-width:220px;vertical-align:top;display:inline-block');
    box.appendChild(h('div', 'color:#b8b8c8;font-weight:600;font-size:13px;margin-bottom:5px', title));
    for (const [lab, n] of rows) {
      const r = h('div', 'display:flex;align-items:center;gap:8px;font-size:12px;margin:2px 0');
      r.append(h('div', 'width:150px;color:#cfd0da;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', lab),
        h('div', 'flex:0 0 44px;text-align:right;color:#8a8a9a', `${total ? (n / total * 100).toFixed(1) : '0'}%`),
        h('div', 'flex:0 0 40px;text-align:right;color:#6a6a7a', String(n)));
      box.appendChild(r);
    }
    return box;
  }

  function run(): void {
    out.innerHTML = '';
    if (batch <= 1) { out.appendChild(card(rollOne(seed))); return; }
    let hpSum = 0, dmgSum = 0, affSum = 0;
    const aff: Record<string, number> = {};
    for (let i = 0; i < batch; i++) {
      const m = rollOne((seed + i) & 0xffffff);
      hpSum += m.hp; dmgSum += m.damage; affSum += m.affixes.length;
      for (const a of m.affixes) aff[a] = (aff[a] ?? 0) + 1;
    }
    out.appendChild(h('div', 'color:#8a8a9a;font-size:12px;margin-bottom:10px',
      `${batch} роллов${baseId ? '' : ' (случайный из пула)'} · ур.${level} · редкость ${rarName(rarity)} · средн. HP ${Math.round(hpSum / batch)} · средн. урон ${Math.round(dmgSum / batch)} · средн. аффиксов ${(affSum / batch).toFixed(2)}`));
    const wrap = h('div', '');
    const topAff = Object.entries(aff).sort((a, b) => b[1] - a[1]).slice(0, 20) as [string, number][];
    if (topAff.length) wrap.appendChild(distTable('Аффиксы (частота, топ-20)', topAff, batch));
    else wrap.appendChild(h('div', 'color:#6a6a7a;font-size:12px', 'аффиксов не выпало'));
    out.appendChild(wrap);
  }

  run();
}
