import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { ConfigRegistry } from '@dm/shared';

/**
 * ⭐ R21-01: `db:repair` ПРОВЕРЯЕТ ОВЕРРАЙДЫ ВМЕСТЕ — тем же кандидатом, что собирает сервер. Раньше каждый ключ пробовался один поверх
 * файлов, а приведение правила баффа (D4) считалось против файлов: годный вместе набор хозяина (отдых 1.0 в балансе при поднятых откатах
 * древа и вставок) звался «✗ не проходит валидацию», а древо, годное при отдыхе 0.1 из базы, `--fix` «приводил» против отдыха файла —
 * потолок ранга клича 8 → 6 записывался в базу навсегда (вложенные ранги 7–8 откат больше не режут, вернуть очки — платный сброс; D2).
 * Против НАСТОЯЩЕЙ базы `dungeon_test` в своей схеме (`testDb.ts`): порядок строк — порядок кучи (UPDATE уносит строку в конец).
 */
const tdb = await vi.hoisted(async () => (await import('./testDb.js')).testDb('cfgrepair'));

let db: typeof import('./db.js');
let pool: typeof import('./pool.js');
let repair: typeof import('./repairOverrides.js');
let alive = false;
beforeAll(async () => {
  alive = await tdb.open();
  pool = await import('./pool.js');
  db = await import('./db.js');
  repair = await import('./repairOverrides.js');
  if (alive) await pool.initSchema();
});
afterAll(async () => { if (alive) { await pool.closePool(); await tdb.drop(); } });

type Tree = { nodes: { id: string; maxRank: number; effect: { active?: { category?: string; cooldown: number } } }[] };
type Ins = { id: string; proc?: { ability: { category?: string; cooldown: number } } }[];
const file = (): ConfigRegistry => { const c = new ConfigRegistry(); c.loadAll(); return c; };
const WARCRY = 'b-class-warrior-a5';

describe.runIf(process.env.DM_SKIP_PG !== '1')('⭐ R21-01: db:repair — набор оверрайдов вместе, как у сервера', () => {
  beforeEach(async () => { if (alive) await pool.q('DELETE FROM config_overrides'); });
  const run = async (): Promise<{ report: import('./repairOverrides.js').RepairReport; lines: string[] }> => {
    const lines: string[] = [];
    const report = await repair.repairOverrides({ overrides: await db.getConfigOverrides(), fix: true, write: db.setConfigOverride, out: (l) => { lines.push(l); } });
    return { report, lines };
  };

  it('отдых 1.0 + экономика хозяина, древо и вставки ×3 (строка баланса обновлена — в конце кучи): ни «✗», ни записи', async () => {
    if (!alive) return;
    const f = file();
    const tree = structuredClone(f.get('skill-tree')) as unknown as Tree;
    for (const n of tree.nodes) if (n.effect.active?.category === 'buff') n.effect.active.cooldown = Math.round(n.effect.active.cooldown * 300) / 100;
    const ins = structuredClone(f.get('skill-inserts')) as unknown as Ins;
    for (const i of ins) if (i.proc?.ability.category === 'buff') i.proc.ability.cooldown = Math.round(i.proc.ability.cooldown * 300) / 100;
    const balance = { ...structuredClone(f.get('balance')), buffMinRest: 1.0, attributePointsPerLevel: 7, respecCost: 12345 };
    await db.setConfigOverride('skill-tree', tree);
    await db.setConfigOverride('balance', balance);
    await db.setConfigOverride('skill-inserts', ins);
    await db.setConfigOverride('balance', balance);   // «любая следующая правка» — строка в конец кучи
    const rev = await db.getConfigOverridesRev();
    const { report, lines } = await run();
    expect(report.broken, `было: «✗ balance не проходит валидацию»\n${lines.join('\n')}`).toEqual([]);
    expect(report.upgraded).toEqual([]);
    expect(report.written).toEqual([]);
    expect(await db.getConfigOverridesRev(), 'в базу ничего не записано').toBe(rev);
    expect(lines.join('\n')).toMatch(/Все сохранённые оверрайды конфига проходят валидацию/);
  });

  it('отдых 0.1 и клич 12 с × 8 рангов (годно вместе): --fix не «приводит» потолок 8 → 6', async () => {
    if (!alive) return;
    const f = file();
    const tree = structuredClone(f.get('skill-tree')) as unknown as Tree;
    const wc = tree.nodes.find((n) => n.id === WARCRY)!;
    wc.effect.active!.cooldown = 12; wc.maxRank = 8;
    await db.setConfigOverride('balance', { ...structuredClone(f.get('balance')), buffMinRest: 0.1 });
    await db.setConfigOverride('skill-tree', tree);
    const { report } = await run();
    expect(report).toEqual({ broken: [], upgraded: [], written: [], files: [] });
    const stored = (await db.getConfigOverrides())['skill-tree'] as Tree;
    expect(stored.nodes.find((n) => n.id === WARCRY)!.maxRank, 'в базе — потолок хозяина').toBe(8);
  });

  it('контроль: древо старше правила (клич 12 с × 20 рангов при отдыхе файла) — приводится и записывается, как прежде', async () => {
    if (!alive) return;
    const tree = structuredClone(file().get('skill-tree')) as unknown as Tree;
    const wc = tree.nodes.find((n) => n.id === WARCRY)!;
    wc.effect.active!.cooldown = 12; wc.maxRank = 20;
    await db.setConfigOverride('skill-tree', tree);
    const { report, lines } = await run();
    expect(report.upgraded).toEqual(['skill-tree']);
    expect(report.written).toEqual(['skill-tree']);
    expect(lines.join('\n')).toMatch(/b-class-warrior-a5\.maxRank: 20 → 6/);
    const stored = (await db.getConfigOverrides())['skill-tree'] as Tree;
    expect(stored.nodes.find((n) => n.id === WARCRY)!.maxRank).toBe(6);
  });
});
