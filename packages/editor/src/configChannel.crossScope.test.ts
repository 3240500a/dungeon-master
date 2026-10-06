import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { configCrossIssues, defaultConfigData, type ConfigShapes } from '@dm/shared';
import { LiveConfigBase, bundledWorkingCopy } from './liveConfig.js';
import { ConfigChannel } from './configChannel.js';
import { serverRig, type ServerRig, type Tables } from './configChannel.fuzzKit.js';

/**
 * ⭐ РЕДАКТОР ≡ СЕРВЕР ДЛЯ ПРАВИЛ ПОВЕРХ ТАБЛИЦ (рецензия 06.10): правка таблицы проверяется только правилами, которые её читают, и отказ —
 * только новому или углублённому нарушению. Прежде нарушение цен D4, лежащее в живом конфиге (оверрайд сырья хозяина, принятый сервером с
 * инцидентом), запирало в редакторе сохранение древа скилов («skill-tree: … craft-materials: ⭐ D4 …»), а сервер такую правку — тоже.
 */
type Mats = ConfigShapes['craft-materials'];
async function editorOn(s: ServerRig): Promise<{ data: Tables; ch: ConfigChannel; said: string[] }> {
  const data = bundledWorkingCopy();
  const live = new LiveConfigBase();
  const snap = await s.read();
  live.accept(snap);
  Object.assign(data, snap);
  const said: string[] = [];
  const ch = new ConfigChannel(data, live, {
    send: s.send, read: () => s.read(), post: () => undefined, status: (t) => { said.push(t); }, label: (k) => k, later: (fn) => { fn(); },
  });
  return { data, ch, said };
}

describe('⭐ редактор: лежащее нарушение не запирает чужие таблицы, новое — отказ до отправки', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); });

  /** Хозяин поднял цены сырья выше допуска D4 (таблица с эссенцией — сборка её не приводит): сервер собрал её с инцидентом. */
  async function dearServer(): Promise<ServerRig> {
    const s = await serverRig();
    const dear = (structuredClone(defaultConfigData['craft-materials']) as Mats).map((m) => (m.tier >= 4 && m.family !== 'ench' ? { ...m, sellPrice: m.sellPrice * 8 } : m));
    s.rows.set('craft-materials', dear);
    await s.live.rebuild();
    expect(configCrossIssues((k) => s.config.get(k)).some((i) => i.rule === 'salvage-sell'), 'нарушение лежит в живом').toBe(true);
    return s;
  }

  it('древо скилов и несвязанная правка баланса — сохраняются (редактор и сервер)', async () => {
    const s = await dearServer();
    const e = await editorOn(s);
    const tree = e.ch.validated(['skill-tree']);
    expect(tree, `было: ${e.said.at(-1)}`).not.toBeNull();
    expect(await e.ch.push(tree!)).toBe(true);
    (e.data.balance as { respecCost: number }).respecCost = 4321;
    const bal = e.ch.validated(['balance']);
    expect(bal).not.toBeNull();
    expect(await e.ch.push(bal!)).toBe(true);
    expect(s.config.get('balance').respecCost).toBe(4321);
  });

  it('цены сырья ещё выше — отказ редактора до отправки (и сервер бы отказал)', async () => {
    const s = await dearServer();
    const e = await editorOn(s);
    e.data['craft-materials'] = (structuredClone(e.data['craft-materials']) as Mats).map((m) => (m.tier === 5 && m.family !== 'ench' ? { ...m, sellPrice: m.sellPrice * 3 } : m));
    expect(await s.live.trial({ 'craft-materials': e.data['craft-materials'] }), 'сервер отказывает').not.toBeNull();
    expect(e.ch.validated(['craft-materials'])).toBeNull();
    expect(e.said.at(-1)).toMatch(/Ошибка валидации «craft-materials»: ⭐ D4/);
  });
});
