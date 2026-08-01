import {
  ConfigRegistry, generateRunPlan, generateFloor, resolveMonsterPool, spawnPacksEl, createRng,
  Cell, TILE, type RunConfig, type RunPlan, type RunNode, type RunModifier, type RunTemplate, type Biome,
  type DungeonLayout, type MonsterSpawn,
} from '@dm/shared';

/**
 * Вкладка «Забеги v2»: слева алтарь-тюнинг (биом/длина/тир/ветвление/мощь/модификаторы), в центре
 * СХЕМА забега (ветвящийся граф узлов, как Slay the Spire / трайлы PoE2), снизу — поклеточный
 * просмотр выбранного узла-этажа с монстрами и hover-подсказками (генерация из @dm/shared в браузере).
 * Всё считается на ТЕКУЩЕЙ (правленой) копии конфигов.
 */

// ── Состояние страницы (переживает перерисовки) ──────────────────────────────
interface Tuning {
  templateId: string;
  biomeId: string;
  tier: string;
  seed: number;
  length: number;
  widthMax: number;
  branching: number;
  returnEvery: number;
  bossEvery: number;
  /** Мощь персонажа = эфф. уровень (уровень + гир + пассивы) — влияет на уровни монстров. */
  power: number;
  modifiers: Set<string>;
}
let tuning: Tuning | null = null;
let plan: RunPlan | null = null;
let selectedNodeId: string | null = null;
let gpan = { x: 40, y: 0 };
let gzoom = 1;
// Пан/зум просмотрщика этажа (как в карте забега). Сбрасываются под каждый выбранный этаж.
let fpan = { x: 0, y: 0 };
let fzoom = 1;

const TYPE_STYLE: Record<string, { fill: string; label: string; glyph: string }> = {
  start: { fill: '#3a3a4c', label: 'Старт', glyph: '⌂' },
  combat: { fill: '#7a3a3a', label: 'Бой', glyph: '⚔' },
  elite: { fill: '#a8642a', label: 'Элита', glyph: '★' },
  boss: { fill: '#7a2a5a', label: 'Босс', glyph: '☠' },
  treasure: { fill: '#8a7a2a', label: 'Клад', glyph: '◆' },
  event: { fill: '#2a5a7a', label: 'Событие', glyph: '?' },
  shop: { fill: '#2a6a5a', label: 'Лавка', glyph: '$' },
  rest: { fill: '#2a6a2a', label: 'Город', glyph: '⛺' },
  finale: { fill: '#a83a3a', label: 'Финал', glyph: '♛' },
};
const FACTION_COLOR: Record<string, string> = {
  undead: '#b6b6d8', beast: '#c08a45', demon: '#d85a5a', monster: '#7fa0d0',
};
const FACTION_LABEL: Record<string, string> = {
  undead: 'нежить', beast: 'зверь', demon: 'демон', monster: 'конструкт',
};

function regFromData(data: Record<string, unknown>): ConfigRegistry {
  const reg = new ConfigRegistry();
  reg.loadAll(data);
  return reg;
}

// ── UI-хелперы ────────────────────────────────────────────────────────────────
function row(label: string, input: HTMLElement): HTMLElement {
  const r = document.createElement('label');
  r.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:13px;margin:4px 0';
  const s = document.createElement('span');
  s.textContent = label; s.style.color = '#b8b8c8';
  r.append(s, input);
  return r;
}
function numInput(value: number, onChange: (v: number) => void, width = 90): HTMLInputElement {
  const i = document.createElement('input');
  i.type = 'number'; i.value = String(value);
  i.style.cssText = `width:${width}px;background:#12121a;color:#e8e8f0;border:1px solid #2c2c3a;border-radius:4px;padding:4px 6px`;
  i.addEventListener('input', () => onChange(Number(i.value)));
  return i;
}
function rangeRow(label: string, value: number, min: number, max: number, step: number, fmt: (v: number) => string, onChange: (v: number) => void): HTMLElement {
  const out = document.createElement('span'); out.textContent = fmt(value); out.style.color = '#caa64b'; out.style.minWidth = '34px'; out.style.textAlign = 'right';
  const rng = document.createElement('input');
  rng.type = 'range'; rng.min = String(min); rng.max = String(max); rng.step = String(step); rng.value = String(value);
  rng.style.cssText = 'width:120px';
  rng.addEventListener('input', () => { const v = Number(rng.value); out.textContent = fmt(v); onChange(v); });
  const wrap = document.createElement('span'); wrap.style.cssText = 'display:flex;align-items:center;gap:6px';
  wrap.append(rng, out);
  return row(label, wrap);
}
function selectInput(opts: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const s = document.createElement('select');
  s.style.cssText = 'background:#12121a;color:#e8e8f0;border:1px solid #2c2c3a;border-radius:4px;padding:4px 6px;max-width:180px';
  for (const [v, l] of opts) {
    const o = document.createElement('option');
    o.value = v; o.textContent = l; if (v === value) o.selected = true;
    s.append(o);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}
function modEffectText(m: RunModifier): string {
  return m.effects.map((e) => `${e.stat} ${e.op === 'mul' ? '×' : '+'}${e.value}`).join(', ') || m.desc;
}

function tuningFromTemplate(reg: ConfigRegistry, templateId: string, seed: number, prevBiome?: string, prevPower?: number): Tuning {
  const t = (reg.get('run-templates') as RunTemplate[]).find((x) => x.id === templateId) ?? (reg.get('run-templates') as RunTemplate[])[0]!;
  const biomes = reg.get('biomes') as Biome[];
  return {
    templateId: t.id,
    biomeId: prevBiome && biomes.some((b) => b.id === prevBiome) ? prevBiome : biomes[0]!.id,
    tier: t.tier, seed,
    length: Math.round((t.length.min + t.length.max) / 2),
    widthMax: t.width.max, branching: t.branching,
    returnEvery: t.returnEvery, bossEvery: t.bossEvery,
    power: prevPower ?? 20,
    modifiers: new Set<string>(),
  };
}

function buildConfig(t: Tuning): RunConfig {
  return {
    templateId: t.templateId, biomeId: t.biomeId, tier: t.tier, seed: t.seed,
    length: t.length, widthMax: t.widthMax, branching: t.branching,
    returnEvery: t.returnEvery, bossEvery: t.bossEvery, power: t.power, modifiers: [...t.modifiers],
  };
}

// ── Схема забега (SVG-граф) ──────────────────────────────────────────────────
const COLW = 120, ROWH = 74, NODE_R = 22;

function nodePos(n: RunNode, widthByDepth: Map<number, number>): { x: number; y: number } {
  const w = widthByDepth.get(n.depth) ?? 1;
  const x = n.depth * COLW + 40;
  const y = 220 + (n.lane - (w - 1) / 2) * ROWH;
  return { x, y };
}

function renderGraph(host: HTMLElement, p: RunPlan, mods: RunModifier[], onSelect: (id: string) => void): void {
  host.innerHTML = '';
  const SVGNS = 'http://www.w3.org/2000/svg';
  const widthByDepth = new Map<number, number>();
  for (const n of p.nodes) widthByDepth.set(n.depth, Math.max(widthByDepth.get(n.depth) ?? 0, n.lane + 1));
  const byId = new Map(p.nodes.map((n) => [n.id, n]));

  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%');
  svg.style.cssText = 'background:#101017;border:1px solid #2c2c3a;border-radius:8px;cursor:grab;touch-action:none;display:block';

  const defs = document.createElementNS(SVGNS, 'defs');
  defs.innerHTML = `<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#4a4a5a"/></marker>`;
  svg.appendChild(defs);

  const bg = document.createElementNS(SVGNS, 'rect');
  bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%'); bg.setAttribute('fill', 'transparent');
  svg.appendChild(bg);

  const vp = document.createElementNS(SVGNS, 'g');
  svg.appendChild(vp);
  const apply = () => vp.setAttribute('transform', `translate(${gpan.x} ${gpan.y}) scale(${gzoom})`);
  apply();

  const gEdges = document.createElementNS(SVGNS, 'g');
  vp.appendChild(gEdges);
  for (const n of p.nodes) {
    const a = nodePos(n, widthByDepth);
    for (const e of n.edges) {
      const b = byId.get(e.to); if (!b) continue;
      const bp = nodePos(b, widthByDepth);
      const line = document.createElementNS(SVGNS, 'line');
      line.setAttribute('x1', String(a.x + NODE_R)); line.setAttribute('y1', String(a.y));
      line.setAttribute('x2', String(bp.x - NODE_R)); line.setAttribute('y2', String(bp.y));
      line.setAttribute('stroke', '#3a3a48'); line.setAttribute('stroke-width', '2');
      line.setAttribute('marker-end', 'url(#arrow)');
      gEdges.appendChild(line);
    }
  }
  const gNodes = document.createElementNS(SVGNS, 'g');
  vp.appendChild(gNodes);
  for (const n of p.nodes) {
    const pos = nodePos(n, widthByDepth);
    const style = TYPE_STYLE[n.type] ?? TYPE_STYLE.combat!;
    const g = document.createElementNS(SVGNS, 'g');
    g.style.cursor = 'pointer';
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('cx', String(pos.x)); c.setAttribute('cy', String(pos.y)); c.setAttribute('r', String(NODE_R));
    c.setAttribute('fill', style.fill);
    c.setAttribute('stroke', n.id === selectedNodeId ? '#ffd24a' : '#1a1a22');
    c.setAttribute('stroke-width', n.id === selectedNodeId ? '3' : '2');
    g.appendChild(c);
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('x', String(pos.x)); t.setAttribute('y', String(pos.y + 5));
    t.setAttribute('text-anchor', 'middle'); t.setAttribute('font-size', '16'); t.setAttribute('fill', '#f0f0f5');
    t.textContent = style.glyph;
    g.appendChild(t);
    if (n.modifiers.length) {
      const badge = document.createElementNS(SVGNS, 'circle');
      badge.setAttribute('cx', String(pos.x + NODE_R - 4)); badge.setAttribute('cy', String(pos.y - NODE_R + 4)); badge.setAttribute('r', '6');
      const boon = mods.find((m) => m.id === n.modifiers[0])?.kind === 'boon';
      badge.setAttribute('fill', boon ? '#4ade80' : '#e05a5a');
      badge.setAttribute('stroke', '#101017'); badge.setAttribute('stroke-width', '1.5');
      g.appendChild(badge);
    }
    const title = document.createElementNS(SVGNS, 'title');
    title.textContent = `${style.label} · эт.${n.depth}\n${n.modifiers.map((id) => mods.find((m) => m.id === id)?.name ?? id).join('\n')}`;
    g.appendChild(title);
    g.addEventListener('click', () => onSelect(n.id));
    gNodes.appendChild(g);
  }

  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  bg.addEventListener('pointerdown', (e) => { dragging = true; sx = e.clientX; sy = e.clientY; ox = gpan.x; oy = gpan.y; svg.style.cursor = 'grabbing'; (e.target as Element).setPointerCapture?.(e.pointerId); });
  svg.addEventListener('pointermove', (e) => { if (!dragging) return; gpan.x = ox + (e.clientX - sx); gpan.y = oy + (e.clientY - sy); apply(); });
  svg.addEventListener('pointerup', () => { dragging = false; svg.style.cursor = 'grab'; });
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const nz = Math.max(0.3, Math.min(2.5, gzoom * f));
    gpan.x = mx - (mx - gpan.x) * (nz / gzoom);
    gpan.y = my - (my - gpan.y) * (nz / gzoom);
    gzoom = nz; apply();
  }, { passive: false });

  host.appendChild(svg);
}

// ── Поклеточный просмотр этажа (canvas) ──────────────────────────────────────
function cellSize(cols: number): number { return Math.max(4, Math.min(10, Math.floor(640 / cols))); }

function drawFloor(canvas: HTMLCanvasElement, L: DungeonLayout, monsters: MonsterSpawn[], factionColor: string): void {
  const rows = L.grid.length, cols = L.grid[0]?.length ?? 0;
  const cell = cellSize(cols);
  canvas.width = cols * cell; canvas.height = rows * cell;
  const ctx = canvas.getContext('2d')!;
  const COLORS = ['#2a2a34', '#0d0d13', '#7a5a2a', '#4a4a56']; // Floor,Wall,Door,Pillar
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    ctx.fillStyle = COLORS[L.grid[y]![x]!] ?? '#0d0d13';
    ctx.fillRect(x * cell, y * cell, cell, cell);
  }
  const dotWorld = (wx: number, wy: number, color: string, r: number) => {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc((wx / TILE) * cell, (wy / TILE) * cell, r, 0, Math.PI * 2); ctx.fill();
  };
  // монстры
  for (const m of monsters) {
    const champ = m.def.rarity === 'champion';
    dotWorld(m.x, m.y, champ ? '#ffcf4a' : factionColor, champ ? cell * 0.7 : cell * 0.5);
    if (champ) { ctx.strokeStyle = '#101017'; ctx.lineWidth = 1; ctx.stroke(); }
  }
  // декор: портал/сундук/лавка/добыча
  for (const d of L.decor) {
    if (d.kind === 'portal') dotWorld(d.x, d.y, '#8a5cff', cell * 1.1);
    else if (d.kind === 'stash') dotWorld(d.x, d.y, '#c99a48', cell * 0.9);
    else if (d.kind === 'shop') dotWorld(d.x, d.y, '#3fb0a0', cell * 0.9);
    else if (d.kind === 'chest') dotWorld(d.x, d.y, '#e6c34a', cell * 0.8);
  }
  for (const lv of L.levers) dotWorld(lv.x, lv.y, '#facc15', cell * 0.6);
  dotWorld(L.spawn.x, L.spawn.y, '#4ade80', cell * 0.9);
  for (const ex of L.exits) dotWorld(ex.x, ex.y, '#f87171', cell * 0.9); // все выходы
}

/** Описание того, что сгенерировано в клетке под курсором (для hover-подсказки). */
function annotationAt(cx: number, cy: number, L: DungeonLayout, monByCell: Map<string, MonsterSpawn[]>, exitByCell: Map<string, string>): string {
  const near = (wx: number, wy: number) => Math.floor(wx / TILE) === cx && Math.floor(wy / TILE) === cy;
  // Ориентиры (выход/портал/сундук/спавн/рычаг/дверь) — приоритетнее монстра, стоящего на клетке.
  const ex = exitByCell.get(`${cx},${cy}`);
  if (ex) return ex;
  for (const d of L.decor) if (near(d.x, d.y) && d.kind === 'portal') return 'Портал возврата в город';
  for (const d of L.decor) if (near(d.x, d.y) && d.kind === 'stash') return 'Сундук (общий склад аккаунта)';
  for (const d of L.decor) if (near(d.x, d.y) && d.kind === 'shop') return 'Лавка (торговец)';
  for (const d of L.decor) if (near(d.x, d.y) && d.kind === 'chest') return 'Сундук с добычей';
  if (near(L.spawn.x, L.spawn.y)) return 'Точка входа игрока (спавн)';
  for (const lv of L.levers) if (near(lv.x, lv.y)) return `Рычаг → открывает дверь #${lv.doorId}`;
  for (const d of L.doors) if (d.cells.some((c) => c.cx === cx && c.cy === cy)) return `Запертая дверь #${d.id} (нужен рычаг)`;
  const ms = monByCell.get(`${cx},${cy}`);
  if (ms && ms.length) {
    const m = ms[0]!.def;
    const champ = m.rarity === 'champion' ? ' ⭐ЧЕМПИОН' : '';
    const aff = m.affixes.length ? ` · ${m.affixes.join(', ')}` : '';
    const extra = ms.length > 1 ? ` (+${ms.length - 1})` : '';
    return `${m.name} ур.${m.level}${champ}${extra}\nHP ${Math.round(m.hp)} · урон ${m.minDamage}–${m.maxDamage} (${m.damageType})\nфракция: ${FACTION_LABEL[m.faction] ?? m.faction}${aff}`;
  }
  const room = L.rooms.find((r) => cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h);
  const cellVal = L.grid[cy]?.[cx];
  const cellName = cellVal === Cell.Wall ? 'Стена' : cellVal === Cell.Door ? 'Дверь' : cellVal === Cell.Pillar ? 'Колонна' : 'Пол';
  if (room) {
    const content = room.content === 'champion' ? ' · комната чемпионов' : room.content === 'boss' ? ' · босс-комната' : room.content === 'treasure' ? ' · сокровищница' : '';
    return `${cellName} · комната: ${room.type} (${room.w}×${room.h})${content}`;
  }
  return cellName;
}

function legend(): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;margin-top:8px;font-size:11px;color:#9a9aac';
  const items: [string, string][] = [
    ['#2a2a34', 'пол'], ['#0d0d13', 'стена'], ['#7a5a2a', 'дверь'], ['#facc15', 'рычаг'],
    ['#4ade80', 'спавн'], ['#f87171', 'выход'], ['#8a5cff', 'портал'], ['#c99a48', 'сундук'],
    ['#3fb0a0', 'лавка'], ['#e6c34a', 'добыча'], ['#7fa0d0', 'монстр'], ['#ffcf4a', 'чемпион'],
  ];
  for (const [c, l] of items) {
    const s = document.createElement('span'); s.style.cssText = 'display:flex;align-items:center;gap:4px';
    s.innerHTML = `<span style="width:11px;height:11px;border-radius:3px;background:${c};display:inline-block"></span>${l}`;
    el.append(s);
  }
  return el;
}

// ── Точка входа страницы ─────────────────────────────────────────────────────
export function renderRunGenPage(page: HTMLElement, data: Record<string, unknown>): void {
  page.innerHTML = '';
  const reg = regFromData(data);
  const templates = reg.get('run-templates') as RunTemplate[];
  const biomes = reg.get('biomes') as Biome[];
  const diffs = reg.get('difficulties') as { id: string; name: string }[];
  const mods = reg.get('run-modifiers') as RunModifier[];

  if (!templates.length || !biomes.length) {
    page.innerHTML = '<div style="color:#ff8080">Нет конфигов biomes/run-templates.</div>';
    return;
  }
  if (!tuning) tuning = tuningFromTemplate(reg, templates[0]!.id, 12345);
  const t = tuning;

  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:grid;grid-template-columns:300px 1fr;gap:14px;align-items:start';

  // ── Алтарь-тюнинг ──────────────────────────────────────
  const altar = document.createElement('div');
  altar.style.cssText = 'border:1px solid #2c2c3a;border-radius:8px;padding:12px;background:#161620';
  const h = document.createElement('div');
  h.textContent = '⚒ Алтарь забега'; h.style.cssText = 'font-weight:700;margin-bottom:8px;color:#e8e8f0';
  altar.append(h);

  altar.append(row('Шаблон', selectInput(templates.filter((x) => x.enabled !== false).map((x) => [x.id, x.name] as [string, string]), t.templateId,
    (v) => { tuning = tuningFromTemplate(reg, v, t.seed, t.biomeId, t.power); renderRunGenPage(page, data); })));
  altar.append(row('Биом', selectInput(biomes.filter((b) => b.enabled !== false).map((b) => [b.id, b.name] as [string, string]), t.biomeId,
    (v) => { t.biomeId = v; })));
  altar.append(row('Тир', selectInput(diffs.map((d) => [d.id, d.name] as [string, string]), t.tier, (v) => { t.tier = v; })));
  altar.append(rangeRow('Этажей (слоёв)', t.length, 3, 20, 1, (v) => String(v), (v) => { t.length = v; }));
  altar.append(rangeRow('Ветвление', t.branching, 0, 1, 0.05, (v) => v.toFixed(2), (v) => { t.branching = v; }));
  altar.append(rangeRow('Мощь (эфф. ур.)', t.power, 1, 80, 1, (v) => String(v), (v) => { t.power = v; if (selectedNodeId && plan) showFloor(selectedNodeId); }));
  altar.append(row('Макс. ширина', numInput(t.widthMax, (v) => { t.widthMax = Math.max(1, v); }, 60)));
  altar.append(row('Возврат каждые', numInput(t.returnEvery, (v) => { t.returnEvery = Math.max(0, v); }, 60)));
  altar.append(row('Босс каждые', numInput(t.bossEvery, (v) => { t.bossEvery = Math.max(0, v); }, 60)));
  altar.append(row('Сид', numInput(t.seed, (v) => { t.seed = v; })));

  const sep = document.createElement('div');
  sep.style.cssText = 'border-top:1px solid #2c2c3a;margin:10px 0 6px;padding-top:6px;color:#8a8a9a;font-size:12px';
  sep.textContent = 'Модификаторы забега';
  altar.append(sep);
  const tpl = templates.find((x) => x.id === t.templateId);
  const allowed = tpl && tpl.allowedModifiers.length ? tpl.allowedModifiers : null;
  const runMods = mods.filter((m) => m.scope === 'run' && m.enabled !== false && (!allowed || allowed.includes(m.id)));
  for (const m of runMods) {
    const lbl = document.createElement('label');
    lbl.style.cssText = 'display:flex;align-items:flex-start;gap:6px;font-size:12px;margin:3px 0;cursor:pointer';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = t.modifiers.has(m.id);
    cb.addEventListener('change', () => { if (cb.checked) t.modifiers.add(m.id); else t.modifiers.delete(m.id); });
    const txt = document.createElement('span');
    const kindColor = m.kind === 'affliction' || m.kind === 'suffix' ? '#e05a5a' : m.kind === 'boon' || m.kind === 'prefix' ? '#4ade80' : '#caa64b';
    txt.innerHTML = `<span style="color:${kindColor}">${m.name}</span> <span style="color:#7a7a8a">${modEffectText(m)}</span>`;
    lbl.append(cb, txt); altar.append(lbl);
  }
  if (!runMods.length) { const e = document.createElement('div'); e.textContent = 'Нет доступных модификаторов.'; e.style.cssText = 'color:#666;font-size:12px'; altar.append(e); }

  const genBtn = document.createElement('button');
  genBtn.textContent = '▶ Сгенерировать структуру';
  genBtn.style.cssText = 'margin-top:12px;width:100%;padding:9px;cursor:pointer;background:#2a4a2a;color:#e8e8f0;border:1px solid #3c3c4a;border-radius:6px;font-size:14px';
  altar.append(genBtn);

  // ── Правая часть ───────────────────────────────────────
  const right = document.createElement('div');
  right.style.cssText = 'display:flex;flex-direction:column;gap:12px;min-width:0';
  const graphHost = document.createElement('div');
  graphHost.style.cssText = 'position:relative;height:440px;min-width:0';
  const graphEmpty = document.createElement('div');
  graphEmpty.style.cssText = 'height:100%;display:flex;align-items:center;justify-content:center;color:#666;border:1px solid #2c2c3a;border-radius:8px;background:#101017';
  graphEmpty.textContent = 'Настрой алтарь и нажми «Сгенерировать структуру».';
  graphHost.append(graphEmpty);
  const preview = document.createElement('div');
  preview.style.cssText = 'position:relative;border:1px solid #2c2c3a;border-radius:8px;padding:12px;background:#161620;min-height:160px';
  preview.innerHTML = '<div style="color:#666">Выбери узел на схеме — покажу поклеточную геометрию этажа с монстрами.</div>';
  right.append(graphHost, preview);
  wrap.append(altar, right);
  page.appendChild(wrap);

  // ── Логика ─────────────────────────────────────────────
  const showFloor = (nodeId: string): void => {
    selectedNodeId = nodeId;
    if (!plan) return;
    const node = plan.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const biome = biomes.find((b) => b.id === node.biomeId)!;
    let L: DungeonLayout;
    try { L = generateFloor(node.floorSpec); }
    catch (e) { preview.innerHTML = `<div style="color:#ff8080">Ошибка генерации: ${(e as Error).message}</div>`; return; }

    // Монстры этажа по эфф. уровню (мощь) — детерминированно от сида этажа. Town (город) — без монстров.
    const isTown = node.floorSpec.kind === 'town';
    const pool = resolveMonsterPool(biome, node.depth);
    let monsters: MonsterSpawn[] = [];
    if (!isTown) {
      try { monsters = spawnPacksEl(reg, L, node.depth, plan.tier, createRng((node.floorSpec.seed ^ 0x51ed270b) >>> 0 || 1), t.power, pool, node.floorSpec.packDensity); }
      catch { monsters = []; }
    }
    // Выход → целевой узел (развилка: exits[i] соответствует edges[i]).
    const exitByCell = new Map<string, string>();
    node.edges.forEach((e, i) => {
      const ex = L.exits[i]; if (!ex) return;
      const target = plan!.nodes.find((n) => n.id === e.to);
      const label = target ? `${TYPE_STYLE[target.type]?.label ?? target.type} эт.${target.depth}` : e.to;
      exitByCell.set(`${Math.floor(ex.x / TILE)},${Math.floor(ex.y / TILE)}`, `Выход → ${label}`);
    });
    L.exits.forEach((ex, i) => { const k = `${Math.floor(ex.x / TILE)},${Math.floor(ex.y / TILE)}`; if (!exitByCell.has(k)) exitByCell.set(k, `Выход #${i + 1}`); });
    const monByCell = new Map<string, MonsterSpawn[]>();
    for (const m of monsters) { const k = `${Math.floor(m.x / TILE)},${Math.floor(m.y / TILE)}`; (monByCell.get(k) ?? monByCell.set(k, []).get(k)!).push(m); }
    const avgLvl = monsters.length ? Math.round(monsters.reduce((s, m) => s + m.def.level, 0) / monsters.length) : 0;
    const champs = monsters.filter((m) => m.def.rarity === 'champion').length;

    let floors = 0;
    for (const rrow of L.grid) for (const c of rrow) if (c === Cell.Floor) floors++;
    const style = TYPE_STYLE[node.type] ?? TYPE_STYLE.combat!;
    const modNames = node.floorSpec.modifiers.map((id) => mods.find((m) => m.id === id)?.name ?? id);

    preview.innerHTML = '';
    // Шапка: лор биома
    const lore = document.createElement('div');
    lore.style.cssText = 'font-size:12px;color:#caa64b;font-style:italic;margin-bottom:6px';
    lore.textContent = biome.tagline ? `« ${biome.tagline} »` : biome.name;
    preview.appendChild(lore);

    const info = document.createElement('div');
    info.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:#b8b8c8;margin-bottom:6px';
    info.innerHTML =
      `<span style="color:#e8e8f0;font-weight:600">${style.glyph} ${style.label} · эт.${node.depth}</span>` +
      `<span>Биом: <b style="color:#caa64b">${biome.name}</b></span>` +
      `<span>Этаж: <b>${node.floorSpec.floorId || '—'}</b> · роль <b style="color:#caa64b">${node.floorSpec.role}</b> (${node.floorSpec.algoParams.algorithm})</span>` +
      `<span>Сетка: ${L.grid[0]?.length ?? 0}×${L.grid.length}</span>` +
      `<span>Пол: ${floors} кл.</span>` +
      `<span>Комнат: ${L.rooms.length}</span>` +
      `<span>Двери: ${L.doors.length}${node.floorSpec.locked ? ' 🔒' : ''}</span>` +
      `<span>Выходов: <b>${L.exits.length}</b></span>` +
      (isTown ? '<span style="color:#8a5cff">🏚 Город: портал + сундук</span>' : `<span>Монстры: <b>${monsters.length}</b> (ур.~${avgLvl}${champs ? `, чемп. ${champs}` : ''})</span>`) +
      `<span style="color:#4ade80">Проходим ✓</span>`;
    preview.appendChild(info);
    const f = node.floorSpec.features;
    const featList = [
      f.portal && '🌀 портал', f.stash && '📦 сундук', f.shop && '🛒 лавка', f.bossRoom && '☠ босс-комната',
      f.championRooms ? `★ чемпионы ×${f.championRooms}` : '', f.treasureRooms ? `◆ сокровищницы ×${f.treasureRooms}` : '',
    ].filter(Boolean);
    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:12px;color:#8a8a9a;margin-bottom:8px';
    meta.innerHTML = `Фичи: ${featList.length ? featList.join(' · ') : '—'} · плотность ×${node.floorSpec.packDensity}<br>Мощь игрока: ${t.power} · Модификаторы: ${modNames.length ? modNames.join(', ') : '—'} · Сид этажа: ${node.floorSpec.seed}`;
    preview.appendChild(meta);

    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;margin-bottom:8px';
    const reroll = document.createElement('button');
    reroll.textContent = '🎲 Реролл сида этажа';
    reroll.style.cssText = 'padding:5px 10px;cursor:pointer;background:#26406a;color:#e8e8f0;border:1px solid #3c3c4a;border-radius:6px;font-size:12px';
    reroll.addEventListener('click', () => { node.floorSpec.seed = (node.floorSpec.seed * 2654435761 + 1) >>> 0 || 1; showFloor(nodeId); });
    bar.append(reroll);
    preview.appendChild(bar);

    // Вьюпорт с пан/зумом (колесо — зум к курсору, перетаскивание — пан), как в карте забега.
    const vpHint = document.createElement('div');
    vpHint.style.cssText = 'font-size:11px;color:#71718a;margin-bottom:4px';
    vpHint.textContent = 'Колесо — зум, перетаскивание — пан';
    preview.appendChild(vpHint);
    const vp = document.createElement('div');
    vp.style.cssText = 'position:relative;overflow:hidden;border:1px solid #2c2c3a;border-radius:6px;background:#0d0d13;touch-action:none;cursor:grab;width:100%';
    preview.appendChild(vp);
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;position:absolute;left:0;top:0;image-rendering:pixelated;transform-origin:0 0';
    vp.appendChild(canvas);
    drawFloor(canvas, L, monsters, FACTION_COLOR[biome.faction] ?? '#7fa0d0');
    preview.appendChild(legend());

    const applyFT = () => { canvas.style.transform = `translate(${fpan.x}px,${fpan.y}px) scale(${fzoom})`; };
    // Стартовая подгонка по ширине вьюпорта (после попадания в DOM).
    fpan = { x: 0, y: 0 }; fzoom = 1;
    requestAnimationFrame(() => {
      const w = vp.clientWidth || 600;
      fzoom = Math.min(1, w / canvas.width);
      vp.style.height = `${Math.min(Math.round(canvas.height * fzoom) + 2, 540)}px`;
      applyFT();
    });
    applyFT();

    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    vp.addEventListener('pointerdown', (e) => { dragging = true; sx = e.clientX; sy = e.clientY; ox = fpan.x; oy = fpan.y; vp.style.cursor = 'grabbing'; vp.setPointerCapture?.(e.pointerId); });
    vp.addEventListener('pointermove', (e) => { if (!dragging) return; fpan.x = ox + (e.clientX - sx); fpan.y = oy + (e.clientY - sy); applyFT(); });
    vp.addEventListener('pointerup', () => { dragging = false; vp.style.cursor = 'grab'; });
    vp.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const nz = Math.max(0.2, Math.min(5, fzoom * f));
      fpan.x = mx - (mx - fpan.x) * (nz / fzoom);
      fpan.y = my - (my - fpan.y) * (nz / fzoom);
      fzoom = nz; applyFT();
    }, { passive: false });

    // hover-подсказка (единый div на страницу — старый убираем, чтобы не копить)
    document.querySelectorAll('.rungen-tip').forEach((el) => el.remove());
    const tip = document.createElement('div');
    tip.className = 'rungen-tip';
    tip.style.cssText = 'position:fixed;pointer-events:none;z-index:50;background:#0b0b12;border:1px solid #3c3c4a;border-radius:6px;padding:6px 8px;font-size:12px;color:#e8e8f0;white-space:pre;box-shadow:0 4px 14px rgba(0,0,0,.5);display:none;max-width:260px';
    document.body.appendChild(tip);
    const cell = cellSize(L.grid[0]?.length ?? 1);
    canvas.addEventListener('mousemove', (e) => {
      if (dragging) { tip.style.display = 'none'; return; }
      const rect = canvas.getBoundingClientRect(); // учитывает transform (пан/зум)
      const scale = rect.width / canvas.width;
      const cx = Math.floor((e.clientX - rect.left) / scale / cell);
      const cy = Math.floor((e.clientY - rect.top) / scale / cell);
      if (cx < 0 || cy < 0 || cy >= L.grid.length || cx >= (L.grid[0]?.length ?? 0)) { tip.style.display = 'none'; return; }
      tip.textContent = annotationAt(cx, cy, L, monByCell, exitByCell);
      tip.style.display = 'block';
      tip.style.left = `${e.clientX + 12}px`;
      tip.style.top = `${e.clientY + 12}px`;
    });
    canvas.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  };

  const doGenerate = (): void => {
    try {
      const reg2 = regFromData(data);
      plan = generateRunPlan(reg2, buildConfig(t));
      selectedNodeId = plan.startId;
      renderGraph(graphHost, plan, mods, (id) => showFloor(id));
      showFloor(plan.startId);
    } catch (e) {
      graphHost.innerHTML = `<div style="color:#ff8080;padding:12px">Ошибка: ${(e as Error).message}</div>`;
    }
  };
  genBtn.addEventListener('click', doGenerate);

  if (plan) { renderGraph(graphHost, plan, mods, (id) => showFloor(id)); if (selectedNodeId) showFloor(selectedNodeId); }
}
