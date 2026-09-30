import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { ConfigRegistry, gainXp, newCharacterSave, pointsHeld, xpForLevel, ATTRIBUTES, type SaveState } from '@dm/shared';

/**
 * ⭐ D2: ВХОД ГЕРОЯ (`RoomManager.ownedSave` → `sanitize`) — ОДНО ПРАВИЛО ДЛЯ ЖИВОЙ ПРАВКИ КОНФИГА И ГЕРОЕВ, КОТОРЫЕ УЖЕ ЕСТЬ. Правка хозяина
 * (живьём или деплоем) не чеканит и не отнимает заработанного: сейв старше правила вход дописывает ОДИН раз из того, что у героя есть (старт —
 * R19-01, книга заработанного `earned` — вложенное + свободное), записанное не трогает никогда, уровень по кривой не опускает (R9-05).
 * Менеджер — настоящий, база — мок одной строки (`getCharacter`).
 */
const db = vi.hoisted(() => ({ chars: new Map<string, SaveState>() }));
vi.mock('../db/db.js', () => ({
  getCharacter: async (charId: string) => {
    const s = db.chars.get(charId);
    return s ? { userId: 'user-d2', data: structuredClone(s), version: 1 } : null;
  },
  getSession: async () => null,
  getRunLedger: async () => [],
  mergeRunLedger: async () => undefined,
  landedVersion: async () => null,
  putCharacter: async () => null,
  putCharacterOwned: async () => null,
  putCharacterWithStash: async () => ({ ok: false, conflict: 'stash' }),
  getAccountStash: async () => null,
  putAccountStash: () => Promise.resolve(),
}));
vi.mock('../db/telemetry.js', () => ({ upsertPlaySession: () => Promise.resolve(null) }));
vi.mock('../cluster/registry.js', () => ({
  releaseChar: () => Promise.resolve(),
  claimForJoin: (_c: string, node: string) => Promise.resolve(node),
  claimOwner: () => Promise.resolve('node-0'),
}));
vi.mock('../cluster/node.js', () => ({ isDraining: () => false }));

type Entry = { ownedSave(userId: string, charId: string): Promise<{ save: SaveState; version: number } | undefined>; rooms: Map<string, { stop(): void }> };
let RoomManagerCtor: typeof import('./roomManager.js').RoomManager;
const managers: Entry[] = [];
beforeAll(async () => { ({ RoomManager: RoomManagerCtor } = await import('./roomManager.js')); });
afterEach(() => { for (const m of managers.splice(0)) for (const r of m.rooms.values()) r.stop(); });

/** Менеджер на своём конфиге (правка — только его): таймеры менеджера не тикают. */
function manager(cfg: ConfigRegistry): Entry {
  vi.useFakeTimers({ toFake: ['setInterval'] });
  try {
    const m = new RoomManagerCtor(cfg) as unknown as Entry;
    managers.push(m);
    return m;
  } finally { vi.useRealTimers(); }
}
const fresh = (): ConfigRegistry => { const r = new ConfigRegistry(); r.loadAll(); return r; };
/** Воин уровня `lvl`, очки атрибутов вложены в Силу, скилов и мастерства — свободны. */
function stored(cfg: ConfigRegistry, id: string, lvl: number, patch: (s: SaveState) => void = () => undefined): SaveState {
  const s = newCharacterSave(cfg, 'warrior', id, id);
  gainXp(s, cfg.get('balance'), xpForLevel(lvl, cfg.get('balance').xpTable));
  s.attributes.strength += s.unspentAttributePoints;
  s.unspentAttributePoints = 0;
  patch(s);
  db.chars.set(id, structuredClone(s));
  return s;
}
const total = (s: SaveState): number => ATTRIBUTES.reduce((n, a) => n + s.attributes[a], 0) + s.unspentAttributePoints;

describe('⭐ D2: вход дописывает сейв старше правила один раз и не трогает записанное', () => {
  it('сейв без старта и без книги: вход после правки хозяина — старт не выше своих атрибутов, книга = вложенное + свободное; второй вход после ещё одной правки — то же', async () => {
    const cfg = fresh();
    const born = { ...cfg.get('classes').find((c) => c.id === 'warrior')!.startAttributes };
    const s = stored(cfg, 'D2OLD', 20, (x) => { delete x.startAttributes; delete x.earned; });
    cfg.reload({ classes: cfg.get('classes').map((c) => (c.id === 'warrior' ? { ...c, startAttributes: { ...born, strength: born.strength - 3, vitality: born.vitality + 6 } } : c)) });
    cfg.reload({ balance: { ...cfg.get('balance'), attributePointsPerLevel: 1, skillPointsPerLevel: 9 } });
    const rm = manager(cfg);
    const got = (await rm.ownedSave('user-d2', 'D2OLD'))!.save;
    expect(got.startAttributes).toEqual({ ...born, strength: born.strength - 3 });
    expect(got.earned).toEqual(pointsHeld(got, got.startAttributes!));
    expect(total(got), 'итог героя вход не двигает').toBe(total(s));
    expect(got.level).toBe(20);
    // Записано (как легло бы с первой записью героя) — следующий вход после ещё одной правки не меняет ничего.
    db.chars.set('D2OLD', structuredClone(got));
    cfg.reload({ classes: cfg.get('classes').map((c) => (c.id === 'warrior' ? { ...c, startAttributes: { ...born, strength: born.strength + 10 } } : c)) });
    cfg.reload({ balance: { ...cfg.get('balance'), attributePointsPerLevel: 50, masteryPointsPerLevel: 0 } });
    const again = (await rm.ownedSave('user-d2', 'D2OLD'))!.save;
    expect({ start: again.startAttributes, earned: again.earned }).toEqual({ start: got.startAttributes, earned: got.earned });
  });

  it('герой с книгой: правка очков за уровень, строки класса и кривая медленнее с потолком ниже — вход не трогает ни уровня, ни очков, ни книги', async () => {
    const cfg = fresh();
    const s = stored(cfg, 'D2NEW', 40);
    const b = cfg.get('balance');
    cfg.reload({ balance: { ...b, attributePointsPerLevel: b.attributePointsPerLevel + 4, xpTable: b.xpTable.map((v) => Math.round(v * 1.5)).slice(0, 31) } });
    cfg.reload({ classes: cfg.get('classes').map((c) => (c.id === 'warrior' ? { ...c, startAttributes: { ...c.startAttributes, vitality: 1 } } : c)) });
    const got = (await manager(cfg).ownedSave('user-d2', 'D2NEW'))!.save;
    const pick = (x: SaveState): unknown => [x.level, x.xp, x.attributes, x.startAttributes, x.earned, x.unspentAttributePoints, x.unspentSkillPoints, x.unspentMasteryPoints];
    expect(pick(got)).toEqual(pick(s));
  });
});
