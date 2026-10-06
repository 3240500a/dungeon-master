import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigRegistry, ESSENCE_ID, configCrossIssues, defaultConfigData, essenceCost, shopSellPrice, type ConfigShapes, type Item } from '@dm/shared';
import { buildCandidate, candidateText } from './configCandidate.js';
import { economyDrift, liveConfig } from './configLive.js';
import { repairOverrides } from './db/repairOverrides.js';

/**
 * ⭐ ЖИВОЙ КОНФИГ И ЭКОНОМИКА РАЗБОРА (рецензия 06.10). Оверрайды базы хранятся ЦЕЛЫМИ таблицами: `craft-materials`, сохранённый редактором
 * до эссенции и цен D4 (любая галка «булат — позже»), возвращал старую экономику молча — эссенция не падала, чары её не просили, а пол цены
 * лавки превращал старые цены сырья в цены вещей (длинный меч t6 за 756 вместо 134). Сервер стартовал с одной строкой инцидента, а редактор
 * переставал сохранять баланс, ступени, сырьё и правила разбора. Слой файлов проверялся одним правилом баффа, а инцидент про любое
 * нарушение говорил «ядро зажимает откаты».
 */
type Tables = Record<string, unknown>;
/** `craft-materials` как его сохранил редактор до правила: без эссенции, сорта I–V по 1/4/12/36/108. */
function staleCraftMaterials(): ConfigShapes['craft-materials'] {
  const old = [0, 1, 4, 12, 36, 108];
  return (structuredClone(defaultConfigData['craft-materials']) as ConfigShapes['craft-materials'])
    .filter((m) => m.id !== ESSENCE_ID)
    .map((m) => ({ ...m, sellPrice: old[m.tier] ?? m.sellPrice, ...(m.id === 'iron-5' ? { enabled: false } : {}) }));
}
const files = (): Tables => structuredClone(defaultConfigData) as Tables;

describe('⭐ старый оверрайд `craft-materials` (до эссенции и цен D4) — приводится сборкой, а не живёт молча', () => {
  it('кандидат: правило поверх таблиц держится (`crossLeft` пуст), эссенция на месте, цены — файла, галка хозяина жива; приведённое — вслух', () => {
    const c = buildCandidate(files(), { 'craft-materials': staleCraftMaterials() });
    expect(c.applied).toEqual(['craft-materials']);
    expect(c.skipped).toEqual([]);
    expect(c.crossLeft, 'было: шесть нарушений D4 (t1…t6) — сборка без проверки с инцидентом').toEqual([]);
    const mats = c.reg.get('craft-materials');
    expect(mats.find((m) => m.id === ESSENCE_ID)?.enabled, 'было: эссенции нет — разбор её не даёт, чары её не просят').toBe(true);
    expect(mats.find((m) => m.id === 'iron-5')).toMatchObject({ enabled: false, sellPrice: 15 });
    expect(c.fixes['craft-materials']!.some((l) => l.includes(ESSENCE_ID))).toBe(true);
    expect(candidateText.fixed('craft-materials', c.fixes['craft-materials']!)).toMatch(/db:repair/);
    // Цены вещей — формула, а не пол из старых цен сырья: обычный длинный меч t6 продаётся как с файлами.
    const sword = { uid: 's', baseId: 'long-sword', kind: 'weapon', slot: 'weapon', rarity: 'normal', tier: 't6', origin: 'drop', itemLevel: 80, affixes: [], baseStats: [] } as unknown as Item;
    const plain = new ConfigRegistry(); plain.loadAll();
    expect(shopSellPrice(c.reg, sword)).toBe(shopSellPrice(plain, sword));
    const forged = { ...sword, rarity: 'rare' as const };
    expect(essenceCost(c.reg, { ...forged, parts: {} as never }, 'rare', 'reroll')).toBeGreaterThan(0);
  });

  it('`db:repair -- --fix` пишет приведённое в базу: следующая сборка ничего не приводит', async () => {
    const rows: Record<string, unknown> = { 'craft-materials': staleCraftMaterials() };
    const out: string[] = [];
    const rep = await repairOverrides({ overrides: rows, fix: true, out: (l) => { out.push(l); }, write: async (k, v) => { rows[k] = v; } });
    expect(rep.upgraded).toEqual(['craft-materials']);
    expect(rep.written).toEqual(['craft-materials']);
    const again = buildCandidate(files(), rows);
    expect(again.fixes).toEqual({});
    expect(again.crossLeft).toEqual([]);
  });

  it('живой конфиг собирается и правка ЧУЖОЙ таблицы (древо) проходит пробу записи', async () => {
    const rows: Record<string, unknown> = { 'craft-materials': staleCraftMaterials() };
    const config = new ConfigRegistry();
    const said: string[] = [];
    const live = liveConfig({
      config, readOverrides: async () => structuredClone(rows), deleteOverride: async (k) => { delete rows[k]; },
      changed: () => undefined, log: () => undefined, warn: (s) => { said.push(s); }, incident: (s) => { said.push(s); },
    });
    await live.rebuild();
    expect(said.filter((s) => s.includes('ИНЦИДЕНТ')), 'инцидента нет: таблица приведена').toEqual([]);
    expect(await live.trial({ 'skill-tree': structuredClone(config.get('skill-tree')) })).toBeNull();
    expect(await live.trial({ balance: { ...structuredClone(config.get('balance')), respecCost: 4321 } })).toBeNull();
  });
});

describe('⭐ сторожа экономики при сборке (`economyDrift`, предложение §14.4)', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });
  const reg = (patch?: (t: Tables) => void): ConfigRegistry => {
    const t = files();
    patch?.(t);
    const r = new ConfigRegistry();
    r.loadAll(t, { cross: false });
    return r;
  };
  it('файлы как есть — тихо', () => {
    expect(economyDrift(reg())).toEqual([]);
  });
  it('нет эссенции — ИНЦИДЕНТ; эссенция выключена — предупреждение', () => {
    const none = economyDrift(reg((t) => { t['craft-materials'] = (t['craft-materials'] as { id: string }[]).filter((m) => m.id !== ESSENCE_ID); }));
    expect(none).toEqual([expect.objectContaining({ incident: true, line: expect.stringMatching(/нет сырья «ench-essence»/) })]);
    const off = economyDrift(reg((t) => { for (const m of t['craft-materials'] as { id: string; enabled: boolean }[]) if (m.id === ESSENCE_ID) m.enabled = false; }));
    expect(off).toEqual([expect.objectContaining({ incident: false, line: expect.stringMatching(/выключена/) })]);
  });
  it('рецепт разбора не равен файлу — предупреждение (правка законна, но сорта разбора не файла)', () => {
    const d = economyDrift(reg((t) => { (t.balance as { salvage: { recipeByTier: number[][] } }).salvage.recipeByTier[0] = [1, 1, 1, 1]; }));
    expect(d).toEqual([]);
    const moved = economyDrift(reg((t) => { (t.balance as { salvage: { recipeByTier: number[][] } }).salvage.recipeByTier.push([5, 5, 5, 5]); }));
    expect(moved).toEqual([expect.objectContaining({ incident: false, line: expect.stringMatching(/recipeByTier/) })]);
  });
  it('потолок лавки — нет такой ступени: ИНЦИДЕНТ (лавка закрыта запасной ступенью, а не без лимита)', () => {
    const d = economyDrift(reg((t) => { (t.balance as { shop: { maxTier: string } }).shop.maxTier = 'T4'; }));
    expect(d).toEqual([expect.objectContaining({ incident: true, line: expect.stringMatching(/«T4».*запасной ступени «t4»/) })]);
  });
  it('сборка говорит это вслух: инцидент — в инциденты, предупреждение — в предупреждения', async () => {
    const stale = staleCraftMaterials().filter(() => true);
    const withEss = [...stale, { ...(defaultConfigData['craft-materials'] as ConfigShapes['craft-materials']).find((m) => m.id === ESSENCE_ID)!, enabled: false }];
    const rows: Record<string, unknown> = { 'craft-materials': withEss.map((m) => ({ ...m, sellPrice: 1 })) };
    const config = new ConfigRegistry();
    const warned: string[] = [], incidents: string[] = [];
    const live = liveConfig({
      config, readOverrides: async () => structuredClone(rows), deleteOverride: async () => undefined,
      changed: () => undefined, log: () => undefined, warn: (s) => { warned.push(s); }, incident: (s) => { incidents.push(s); },
    });
    await live.rebuild();
    expect(warned.join('\n')).toMatch(/Чародейская эссенция[\s\S]*выключена/);
    expect(incidents).toEqual([]);
  });
});

describe('⭐ слой файлов — всеми правилами поверх таблиц, текст инцидента — по правилу', () => {
  it('«в файл»: сырьё дороже допуска D4 — отказ слою файлов (прежде слой видел только время баффа)', async () => {
    const config = new ConfigRegistry();
    const rows: Record<string, unknown> = {};
    const live = liveConfig({
      config, readOverrides: async () => structuredClone(rows), deleteOverride: async () => undefined,
      changed: () => undefined, log: () => undefined, warn: () => undefined, incident: () => undefined,
    });
    await live.rebuild();
    const dear = structuredClone(config.get('craft-materials')).map((m) => (m.tier === 5 ? { ...m, sellPrice: 300 } : m));
    expect(await live.trial({ 'craft-materials': dear }, { files: true })).toMatch(/craft-materials[\s\S]*D4/);
    // Годная правка того же файла — проходит.
    const ok = structuredClone(config.get('craft-materials')).map((m) => (m.id === 'iron-1' ? { ...m, name: 'Болотное железо (правка)' } : m));
    expect(await live.trial({ 'craft-materials': ok }, { files: true })).toBeNull();
  });

  it('`crossLeft`: у каждого правила — что делает ядро (у разбора — не «зажимает откаты»)', () => {
    const r = new ConfigRegistry();
    r.loadAll({ ...files(), 'craft-materials': staleCraftMaterials() }, { cross: false });
    const text = candidateText.crossLeft(configCrossIssues((k) => r.get(k)));
    expect(text).toMatch(/\[salvage-sell: D4 держит пол цены в ядре/);
    expect(text).not.toMatch(/зажимает откаты/);
  });
});
