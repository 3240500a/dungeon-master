import { ConfigRegistry, runSim, runSessionSim, DEFAULT_BUILD, type ScenarioKind, type SimSettings, type SimOutput, type RunReport } from '@dm/shared';

/**
 * Вкладка «Симулятор»: настройки слева, прогон на ТЕКУЩЕЙ (правленой) копии
 * конфигов, результаты справа. Режим «Полный прогон (бот)» гоняет НАСТОЯЩЕЕ игровое
 * ядро (GameSession) ботом и даёт отчёт как d2planner: финальный билд + статы забегов
 * + кривая. Остальные режимы — быстрый абстрактный сим (бой/этаж/прокачка).
 * Правишь баланс на других вкладках → сюда → «Запустить» → видишь эффект.
 */

/** Режим вкладки: полный прогон на GameSession или один из абстрактных сценариев. */
type Mode = 'run' | ScenarioKind;
let mode: Mode = 'run';

let S: SimSettings = {
  scenario: 'progression',
  classId: 'warrior',
  difficultyId: 'normal',
  level: 20,
  floor: 1,
  targetLevel: 15,
  maxHours: 4,
  iterations: 30,
  seed: 12345,
  floorOverheadSec: 25,
  build: { ...DEFAULT_BUILD },
};

function regFromData(data: Record<string, unknown>): ConfigRegistry {
  const reg = new ConfigRegistry();
  reg.loadAll(data);
  return reg;
}

function row(label: string, input: HTMLElement): HTMLElement {
  const r = document.createElement('label');
  r.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:13px;margin:4px 0';
  const s = document.createElement('span');
  s.textContent = label;
  s.style.color = '#b8b8c8';
  r.append(s, input);
  return r;
}

function numInput(value: number, onChange: (v: number) => void, width = 90): HTMLInputElement {
  const i = document.createElement('input');
  i.type = 'number';
  i.value = String(value);
  i.style.cssText = `width:${width}px;background:#12121a;color:#e8e8f0;border:1px solid #2c2c3a;border-radius:4px;padding:4px 6px`;
  i.addEventListener('input', () => onChange(Number(i.value)));
  return i;
}

function selectInput(opts: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const s = document.createElement('select');
  s.style.cssText = 'background:#12121a;color:#e8e8f0;border:1px solid #2c2c3a;border-radius:4px;padding:4px 6px';
  for (const [v, l] of opts) {
    const o = document.createElement('option');
    o.value = v; o.textContent = l;
    if (v === value) o.selected = true;
    s.append(o);
  }
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function pct(n: number): string { return `${Math.round(n * 100)}%`; }
function f2(n: number): string { return n.toFixed(2); }

function curveSvg(curve: { hours: number; level: number }[]): string {
  if (curve.length < 2) return '<div style="color:#666">Мало точек для графика.</div>';
  const W = 520, H = 220, pad = 34;
  const maxH = Math.max(...curve.map((c) => c.hours)) || 1;
  const maxL = Math.max(...curve.map((c) => c.level)) || 1;
  const x = (h: number) => pad + (h / maxH) * (W - 2 * pad);
  const y = (l: number) => H - pad - (l / maxL) * (H - 2 * pad);
  const pts = curve.map((c) => `${x(c.hours).toFixed(1)},${y(c.level).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;background:#12121a;border:1px solid #2c2c3a;border-radius:8px">
    <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#3c3c4a"/>
    <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${H - pad}" stroke="#3c3c4a"/>
    <polyline points="${pts}" fill="none" stroke="#caa64b" stroke-width="2"/>
    <text x="${W - pad}" y="${H - 10}" fill="#8a8a9a" font-size="11" text-anchor="end">${f2(maxH)} ч</text>
    <text x="6" y="${pad + 4}" fill="#8a8a9a" font-size="11">ур.${maxL}</text>
    <text x="${W / 2}" y="${H - 6}" fill="#8a8a9a" font-size="11" text-anchor="middle">часы →</text>
  </svg>`;
}

function renderResults(out: SimOutput, ms: number): string {
  const head = `<div style="color:#8a8a9a;font-size:12px;margin-bottom:8px">Прогон за ${ms} мс</div>`;
  if (out.fight) {
    const f = out.fight;
    return head + `<table style="font-size:13px;line-height:1.7">
      <tr><td style="color:#b8b8c8;padding-right:16px">Игрок ур. / мощь</td><td>${f.playerLevel} / ${f.power}</td></tr>
      <tr><td style="color:#b8b8c8">Монстры ур.</td><td>${f.challengeLevel}</td></tr>
      <tr><td style="color:#b8b8c8">Победы</td><td><b>${pct(f.winRate)}</b></td></tr>
      <tr><td style="color:#b8b8c8">Время боя</td><td>${f2(f.avgTimeSec)} с</td></tr>
      <tr><td style="color:#b8b8c8">HP в конце (победы)</td><td>${pct(f.avgHpFracOnWin)}</td></tr>
      <tr><td style="color:#b8b8c8">DPS исх / вх</td><td>${f2(f.avgDpsOut)} / ${f2(f.avgDpsIn)}</td></tr>
    </table>`;
  }
  if (out.floor) {
    const f = out.floor;
    return head + `<table style="font-size:13px;line-height:1.7">
      <tr><td style="color:#b8b8c8;padding-right:16px">Вызов ур.</td><td>${f.challengeLevel}</td></tr>
      <tr><td style="color:#b8b8c8">Зачистка / смерти</td><td><b>${pct(f.clearRate)}</b> / ${pct(f.deathRate)}</td></tr>
      <tr><td style="color:#b8b8c8">Время этажа</td><td>${f2(f.avgTimeSec)} с (${f2(f.avgPacks)} пачек)</td></tr>
      <tr><td style="color:#b8b8c8">XP / золото / дроп</td><td>${Math.round(f.avgXp)} / ${Math.round(f.avgGold)} / ${f2(f.avgDrops)}</td></tr>
      <tr><td style="color:#b8b8c8">Мин. HP на этаже</td><td>${pct(f.avgMinHpFrac)}</td></tr>
    </table>`;
  }
  if (out.progression) {
    const p = out.progression;
    const rows = p.curve.map((c) =>
      `<tr><td style="text-align:right;padding-right:12px">${c.level}</td><td style="text-align:right;padding-right:12px">${f2(c.hours)}</td><td style="text-align:right;padding-right:12px">${c.floor}</td><td style="text-align:right">${c.power}</td></tr>`).join('');
    return head +
      `<div style="font-size:13px;margin-bottom:8px">Достигнут <b>ур.${p.reachedLevel}</b> за <b>${f2(p.totalHours)} ч</b> · смертей ${p.deaths} · стена: ${p.wallFloor ?? '—'}</div>` +
      curveSvg(p.curve) +
      `<table style="font-size:12px;margin-top:10px"><tr style="color:#8a8a9a"><td style="padding-right:12px">ур</td><td style="padding-right:12px">часы</td><td style="padding-right:12px">этаж</td><td>мощь</td></tr>${rows}</table>`;
  }
  return head + '<div style="color:#666">Нет результата.</div>';
}

/** SVG-кривая двух рядов: уровень и мощь во времени (часы). */
function runCurveSvg(curve: { timeSec: number; level: number; power: number }[]): string {
  if (curve.length < 2) return '<div style="color:#666">Мало точек для графика.</div>';
  const W = 520, H = 200, pad = 34;
  const maxH = Math.max(...curve.map((c) => c.timeSec)) / 3600 || 1;
  const maxV = Math.max(...curve.map((c) => Math.max(c.level, c.power))) || 1;
  const x = (t: number) => pad + (t / 3600 / maxH) * (W - 2 * pad);
  const y = (v: number) => H - pad - (v / maxV) * (H - 2 * pad);
  const line = (key: 'level' | 'power', color: string): string =>
    `<polyline points="${curve.map((c) => `${x(c.timeSec).toFixed(1)},${y(c[key]).toFixed(1)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;background:#12121a;border:1px solid #2c2c3a;border-radius:8px">
    <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#3c3c4a"/>
    <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${H - pad}" stroke="#3c3c4a"/>
    ${line('level', '#caa64b')}${line('power', '#6a86ff')}
    <text x="${W - pad}" y="${H - 10}" fill="#8a8a9a" font-size="11" text-anchor="end">${f2(maxH)} ч</text>
    <text x="6" y="${pad + 4}" fill="#8a8a9a" font-size="11">${maxV}</text>
    <text x="${pad + 8}" y="${pad - 2}" fill="#caa64b" font-size="11">уровень</text>
    <text x="${pad + 78}" y="${pad - 2}" fill="#6a86ff" font-size="11">мощь</text>
  </svg>`;
}

function statBox(label: string, value: string, accent = '#e8e8f0'): string {
  return `<div style="background:#12121a;border:1px solid #2c2c3a;border-radius:6px;padding:6px 10px">
    <div style="color:#8a8a9a;font-size:11px">${label}</div><div style="color:${accent};font-size:16px;font-weight:bold">${value}</div></div>`;
}

/** Отчёт полного прогона (как d2planner): статы забегов + финальный билд + кривая.
 * Цвета редкости — из конфига `rarities` (data-driven, без хардкода). */
function renderRunReport(r: RunReport, ms: number, rarities: { id: string; color: string }[]): string {
  const rarityColor = (id: string): string => rarities.find((x) => x.id === id)?.color ?? '#c8c8c8';
  const b = r.finalBuild;
  const d = b.derived;
  const grid = (items: string[]): string =>
    `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;margin:8px 0">${items.join('')}</div>`;

  const runStats = grid([
    statBox('Уровень', `${b.level}`, '#caa64b'),
    statBox('Мощь', `${b.power}`, '#6a86ff'),
    statBox('Игровых часов', `${r.totalHours}`),
    statBox('Глубже всего', `эт. ${r.deepestFloor}`),
    statBox('Этажей зачищено', `${r.floorsCompleted}`),
    statBox('Убито', `${r.kills}`),
    statBox('Смертей', `${r.deaths}`, r.deaths > 20 ? '#ff8080' : '#e8e8f0'),
    statBox('Убийств/ч', `${r.killsPerHour}`),
    statBox('XP/ч', `${r.xpPerHour}`),
    statBox('Золото', `${r.goldEarned}`),
    statBox('Предметов', `${r.itemsFound}`),
    statBox('Предм/ч', `${r.lootPerHour}`),
  ]);

  const at = b.attributes, ea = b.effectiveAttributes;
  const attrRow = (['strength', 'dexterity', 'intelligence', 'vitality'] as const)
    .map((k) => `<span style="color:#b8b8c8">${k.slice(0, 3).toUpperCase()}</span> ${at[k]}<span style="color:#6a9a6a">→${ea[k]}</span>`).join(' &nbsp; ');

  const derived = grid([
    statBox('HP', `${d.maxHp}`, '#cf6b6b'),
    statBox('Мана', `${d.maxMana}`, '#6a86ff'),
    statBox('Броня', `${d.armor}`),
    statBox('Уворот', `${d.evade}`),
    statBox('Крит', `${d.critChance}%`, d.critChance >= 100 ? '#ff8080' : '#e8e8f0'),
    statBox('Ск. атаки', `${d.attackSpeed}`),
    statBox('Ур/удар', `~${d.avgHit}`),
  ]);

  const equip = b.equipment.map((e) => {
    const col = rarityColor(e.rarity);
    const tags = [e.weaponType, e.armorClass, e.weight, e.physSub].filter(Boolean).join('/');
    const aff = e.affixes.length ? `<div style="color:#8a8a9a;font-size:11px;margin-left:78px">${e.affixes.join(' · ')}</div>` : '';
    return `<div style="margin:3px 0"><span style="display:inline-block;width:70px;color:#8a8a9a;font-size:12px">${e.slot}</span>
      <span style="color:${col}">${e.name}</span> <span style="color:#666;font-size:11px">${tags}</span>${aff}</div>`;
  }).join('');

  return `<div style="color:#8a8a9a;font-size:12px;margin-bottom:8px">Полный прогон бота на GameSession · ${ms} мс</div>
    <div style="font-size:15px;font-weight:bold;margin-bottom:4px">${r.classId} · ${r.difficultyId} · сид ${r.seed}</div>
    ${runStats}
    <div style="border-top:1px solid #2c2c3a;margin:12px 0 8px;padding-top:8px;color:#b8b8c8;font-weight:bold">Финальный билд</div>
    <div style="font-size:13px;margin:4px 0">${attrRow}</div>
    ${derived}
    <div style="font-size:12px;color:#8a8a9a;margin:6px 0">Активок: ${b.skills.length} · пассив-узлов: ${b.passiveNodes} (рангов ${b.passiveRanks})</div>
    <div style="border-top:1px solid #2c2c3a;margin:8px 0;padding-top:6px">${equip}</div>
    <div style="border-top:1px solid #2c2c3a;margin:12px 0 8px;padding-top:8px;color:#b8b8c8;font-weight:bold">Кривая прокачки</div>
    ${runCurveSvg(r.levelCurve)}`;
}

export function renderSimPage(page: HTMLElement, data: Record<string, unknown>): void {
  page.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:grid;grid-template-columns:280px 1fr;gap:16px;align-items:start';

  // ── Настройки ──────────────────────────────────────────
  const cfg = document.createElement('div');
  cfg.style.cssText = 'border:1px solid #2c2c3a;border-radius:8px;padding:12px;background:#161620';

  const classes = (data.classes as { id: string; name: string }[]) ?? [];
  const diffs = (data.difficulties as { id: string; name: string }[]) ?? [];

  cfg.append(row('Сценарий', selectInput(
    [['run', 'Полный прогон (бот)'], ['progression', 'Прокачка'], ['floor', 'Этаж'], ['fight', 'Бой']],
    mode, (v) => { mode = v as Mode; if (mode !== 'run') S.scenario = mode; renderSimPage(page, data); })));
  cfg.append(row('Класс', selectInput(classes.map((c) => [c.id, c.name] as [string, string]), S.classId, (v) => { S.classId = v; })));
  cfg.append(row('Сложность', selectInput(diffs.map((d) => [d.id, d.name] as [string, string]), S.difficultyId, (v) => { S.difficultyId = v; })));

  if (mode === 'run' || mode === 'progression') {
    cfg.append(row('До уровня', numInput(S.targetLevel, (v) => { S.targetLevel = v; })));
    cfg.append(row('Лимит часов', numInput(S.maxHours, (v) => { S.maxHours = v; })));
  } else {
    cfg.append(row('Уровень игрока', numInput(S.level, (v) => { S.level = v; })));
    cfg.append(row('Этаж', numInput(S.floor, (v) => { S.floor = v; })));
    cfg.append(row('Итераций', numInput(S.iterations, (v) => { S.iterations = v; })));
  }

  cfg.append(row('Сид', numInput(S.seed, (v) => { S.seed = v; })));
  if (mode !== 'run') cfg.append(row('Оверхед/этаж, с', numInput(S.floorOverheadSec, (v) => { S.floorOverheadSec = v; })));

  const sep = document.createElement('div');
  sep.style.cssText = 'border-top:1px solid #2c2c3a;margin:8px 0;color:#8a8a9a;font-size:12px;padding-top:6px';
  sep.textContent = 'Билд бота';
  cfg.append(sep);
  cfg.append(row('Живучесть (доля)', numInput(S.build.vitalityShare, (v) => { S.build.vitalityShare = v; })));
  cfg.append(row('Разброс билда', numInput(S.build.variance, (v) => { S.build.variance = v; })));
  cfg.append(row('Уклон урон (0..1)', numInput(S.build.offenseBias, (v) => { S.build.offenseBias = v; })));
  const skills = document.createElement('input');
  skills.type = 'checkbox'; skills.checked = S.build.useSkills;
  skills.addEventListener('change', () => { S.build.useSkills = skills.checked; });
  cfg.append(row('Скиллы/пассивы', skills));

  const run = document.createElement('button');
  run.textContent = '▶ Запустить';
  run.style.cssText = 'margin-top:10px;width:100%;padding:9px;cursor:pointer;background:#2a4a2a;color:#e8e8f0;border:1px solid #3c3c4a;border-radius:6px;font-size:14px';
  cfg.append(run);

  // ── Результаты ─────────────────────────────────────────
  const res = document.createElement('div');
  res.style.cssText = 'border:1px solid #2c2c3a;border-radius:8px;padding:14px;background:#161620;min-height:220px';
  res.innerHTML = '<div style="color:#666">Настрой параметры и нажми «Запустить». Симуляция использует текущую (правленую) копию конфигов.</div>';

  run.addEventListener('click', () => {
    res.innerHTML = '<div style="color:#8a8a9a">Прогон…</div>';
    // Даём кадр на перерисовку «Прогон…», затем считаем (полный прогон блокирует UI на пару сек).
    setTimeout(() => {
      try {
        const reg = regFromData(data);
        const t0 = performance.now();
        if (mode === 'run') {
          const rep = runSessionSim(reg, {
            classId: S.classId, difficultyId: S.difficultyId, seed: S.seed,
            targetLevel: S.targetLevel, maxHours: S.maxHours, build: S.build,
          });
          res.innerHTML = renderRunReport(rep, Math.round(performance.now() - t0), reg.get('rarities'));
        } else {
          const out = runSim(reg, { ...S, scenario: mode });
          res.innerHTML = renderResults(out, Math.round(performance.now() - t0));
        }
      } catch (e) {
        res.innerHTML = `<div style="color:#ff8080">Ошибка: ${(e as Error).message}</div>`;
      }
    }, 20);
  });

  wrap.append(cfg, res);
  page.appendChild(wrap);
}
