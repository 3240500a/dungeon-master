/**
 * ПРОДЮСЕР И СТОРОЖ golden-эталона ДВОИЧНОГО КАДРА МИРА для Unity-клиента (R16-05).
 *
 * С Ф1.4 сервер шлёт мир ТОЛЬКО двоичным кадром (`WIRE_FULL`/`WIRE_DELTA`, `shared/session/wire.ts`); текстовый
 * `{t:'snapshot'}` уходит лишь под отладочным `DM_WIRE_VERIFY=1`. Unity (`NetClient.ReceiveLoop`) читал любой кадр как
 * UTF-8-текст, двоичный молча пропадал на `JObject.Parse` — и мир у игрока Unity стоял целиком: свой герой, пиры,
 * монстры, снаряды, дропы, полоски HP. Лечится портом декодера на C# (docs/CRAFT_WEAPONS.md §21.1, К8), а порт обязан
 * быть доказуемо равен вебу (веб = источник истины): его собственная ошибка иначе выглядит как баг сервера.
 *
 * Отсюда эталон: кадры РОВНО теми байтами, что уходят в сеть (полный кадр и дельты считают те же `snapshotToDelta` и
 * `SnapshotDelta`, что и комната), и мир, который из них собирает НАСТОЯЩИЙ `NetClient` веба, — на каждом кадре.
 * Мир синтетический, а не из сессии: от баланса эталон не зависит и меняется только вместе с проводом (кодек, дельта,
 * контрольная сумма). Потому это и СТОРОЖ: провод поменяли — тест падает, пока эталон не перезаписан осознанно
 * (`npx vitest run -u packages/client/src/net/unityWireGolden.gen.test.ts`); новый эталон — сигнал порту Unity
 * (скопировать в `Assets/DM/Net/Tests/unity_wire_golden.json`, EditMode-тест обязан сойтись кадр в кадр).
 * Поля кадра `hex`/`kind`/`tick`/`sum` и состав — те же, что у эталона Rust-стенда (`tools/dmload/tests/golden.json`).
 */
import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  SnapshotDelta, angQ, angU, decodeWorldFrame, encodeWorldFrame, snapshotToDelta, worldChecksum, WIRE_DELTA, WIRE_FULL,
  type ActiveDebuff, type Item, type MonsterView, type PlayerView, type WorldDelta, type WorldSnapshot,
} from '@dm/shared';
import { NetClient } from './netClient.js';

/** Угол так, как его кладёт `serializeWorld`: квантование делает сборка снапшота, а не кодек. */
const qa = (a: number): number => angU(angQ(a));
const debuff = (stacks: number, expiresAt: number, mag: number, mag2 = 0): ActiveDebuff => ({ stacks, maxStacks: 5, expiresAt, mag, mag2 });

/** Предмет дропа: JSON внутри двоичного кадра, с кириллицей и символом вне BMP (UTF-8 в 2 и 4 байта). */
const ITEM: Item = {
  uid: 'golden-drop-1', baseId: 'short-sword', name: 'Короткий меч «Жар» 🔥', kind: 'weapon', slot: 'weapon',
  rarity: 'magic', tier: 't2', origin: 'drop', itemLevel: 7, requirements: { strength: 12, dexterity: 8 },
  affixes: [{ affixId: 'fiery', kind: 'prefix', modifier: { stat: 'fireDamageMin', kind: 'flat', value: 3 } }],
  baseStats: [{ stat: 'damageMin', kind: 'flat', value: 4 }, { stat: 'damageMax', kind: 'flat', value: 9 }],
  gridW: 1, gridH: 3, hands: 1, damageType: 'physical',
};

/** Стартовый мир: все четыре списка и крайние значения провода. */
function baseWorld(): WorldSnapshot {
  const a: PlayerView = {
    id: 'p_1f3a', x: 312.25, y: 480.5, facing: qa(1.25), hp: 180, mana: 64, stamina: 90,
    alive: true, inCombat: false, stun: false, debuffs: {}, toggles: [],
  };
  // Id не в ASCII: строка провода — UTF-8, а хеш id в контрольной сумме — по кодовым единицам UTF-16 (пара суррогатов
  // у символа вне BMP), не по байтам. Координаты — отрицательная и потолок int16 (8191,75), угол — последний шаг до 2π.
  const b: PlayerView = {
    id: 'игрок-🔥', x: -12.75, y: 8191.75, facing: angU(65535), hp: 0, mana: 0, stamina: 0,
    alive: false, inCombat: true, stun: true,
    debuffs: { bleed: debuff(2, 1759140000123, 3.5), freeze: debuff(1, 1759140000456, 0.25, 0.1) }, toggles: ['aura-of-might', 'щит'],
  };
  const m1: MonsterView = {
    id: 1, x: 100, y: 100, facing: 0, hp: 40, maxHp: 50, alive: true, stun: false, downed: false, debuffs: {}, r: 12, aiState: 'idle',
  };
  // Радиус провод округляет до байта (12,6 → 13), в контрольную сумму он не входит. Пол int16 — −8192.
  const m2: MonsterView = {
    id: 70000, x: 0.25, y: -8192, facing: qa(3.3), hp: 1, maxHp: 900, alive: true, stun: true, downed: true,
    debuffs: { burn: debuff(3, 1759140000789, 7) }, r: 12.6, aiState: 'chase',
  };
  // Id больше 2^31 (u32 на проводе; `Math.imul` в сумме берёт его со знаком), HP × 16 больше 2^31 (ToInt32 в сумме
  // сворачивает по модулю 2^32 — в C# только через `(int)(long)`), радиус больше байта (зажим в 255).
  const m3: MonsterView = {
    id: 3_000_000_000, x: 2239.75, y: 64, facing: qa(6), hp: 200_000_000, maxHp: 250_000_000, alive: true, stun: false, downed: false,
    debuffs: {}, r: 300, aiState: 'idle',
  };
  return {
    tick: 100,
    players: [a, b],
    monsters: [m1, m2, m3],
    projectiles: [
      { id: 501, x: 320, y: 470.5, owner: 'player', dom: 'fire', r: 6 },
      { id: 502, x: 90.25, y: 101, owner: 'monster', dom: 'cold', r: 4.4 },
    ],
    drops: [
      { id: 900, x: 330, y: 490.25, kind: 'item', item: ITEM },
      { id: 901, x: 340, y: 490, kind: 'gold', gold: 37 },
      { id: 902, x: 350.5, y: 488, kind: 'materials', mats: { 'iron-ingot': 3, 'oak-wood': 1 } },
    ],
  };
}

type Step = { label: string; full?: boolean; edit: (w: WorldSnapshot) => void };
const P = (w: WorldSnapshot, id: string): PlayerView => w.players.find((p) => p.id === id)!;
const M = (w: WorldSnapshot, id: number): MonsterView => w.monsters.find((m) => m.id === id)!;

/** Шаги мира. Каждая дельта меняет по возможности ОДНО поле — порт видит, какой бит маски он прочёл не так. */
const STEPS: Step[] = [
  { label: 'полный кадр: все четыре списка, крайние значения', full: true, edit: () => {} },
  { label: 'игрок: только x (P_X)', edit: (w) => { P(w, 'p_1f3a').x = 313.5; } },
  { label: 'игрок: только y (P_Y)', edit: (w) => { P(w, 'p_1f3a').y = 479.75; } },
  { label: 'игрок: только facing (P_FACING)', edit: (w) => { P(w, 'p_1f3a').facing = 0; } },
  { label: 'игрок: только hp (P_HP)', edit: (w) => { P(w, 'p_1f3a').hp = 175; } },
  { label: 'игрок: только mana (P_MANA)', edit: (w) => { P(w, 'p_1f3a').mana = 60; } },
  { label: 'игрок: только stamina (P_STAMINA)', edit: (w) => { P(w, 'p_1f3a').stamina = 85; } },
  { label: 'игрок: только alive (P_ALIVE — в байте флагов осмыслен один бит)', edit: (w) => { P(w, 'p_1f3a').alive = false; } },
  { label: 'игрок: только inCombat (P_INCOMBAT)', edit: (w) => { P(w, 'p_1f3a').inCombat = true; } },
  { label: 'игрок: только stun (P_STUN = 1024, Ф1.5)', edit: (w) => { P(w, 'p_1f3a').stun = true; } },
  { label: 'игрок: только debuffs (P_DEBUFFS — JSON в кадре)', edit: (w) => { P(w, 'p_1f3a').debuffs = { daze: debuff(1, 1759140001000, 0.3, 0.15) }; } },
  { label: 'игрок: только toggles (P_TOGGLES — JSON в кадре)', edit: (w) => { P(w, 'p_1f3a').toggles = ['aura-of-might']; } },
  {
    label: 'игрок: три флага и оба составных разом, сброс в пустое',
    edit: (w) => { Object.assign(P(w, 'p_1f3a'), { alive: true, inCombat: false, stun: false, debuffs: {}, toggles: [] }); },
  },
  { label: 'монстр: только x (M_X)', edit: (w) => { M(w, 1).x = 101.25; } },
  { label: 'монстр: только y (M_Y)', edit: (w) => { M(w, 1).y = 99.5; } },
  { label: 'монстр: только facing (M_FACING)', edit: (w) => { M(w, 1).facing = qa(2); } },
  { label: 'монстр: только hp (M_HP)', edit: (w) => { M(w, 1).hp = 33; } },
  { label: 'монстр: только maxHp (M_MAXHP)', edit: (w) => { M(w, 1).maxHp = 55; } },
  { label: 'монстр: только alive (M_ALIVE)', edit: (w) => { M(w, 1).alive = false; } },
  { label: 'монстр: только stun (M_STUN)', edit: (w) => { M(w, 1).stun = true; } },
  { label: 'монстр: только downed (M_DOWNED)', edit: (w) => { M(w, 1).downed = true; } },
  { label: 'монстр: только r (M_R)', edit: (w) => { M(w, 1).r = 14; } },
  { label: 'монстр: только aiState (M_AI)', edit: (w) => { M(w, 1).aiState = 'chase'; } },
  { label: 'монстр: только debuffs (M_DEBUFFS — JSON в кадре)', edit: (w) => { M(w, 1).debuffs = { poison: debuff(4, 1759140002000, 2.5) }; } },
  { label: 'монстр: гаснет один флаг (stun), соседние alive/downed не трогать', edit: (w) => { M(w, 70000).stun = false; } },
  {
    label: 'уход: игрок, монстр, снаряд, дроп (pd/md/rd/dd); оставшийся снаряд — целиком в ru',
    edit: (w) => {
      w.players = w.players.filter((p) => p.id !== 'игрок-🔥');
      w.monsters = w.monsters.filter((m) => m.id !== 70000);
      w.projectiles = w.projectiles.filter((r) => r.id !== 501);
      w.drops = w.drops.filter((d) => d.id !== 900);
    },
  },
  { label: 'снарядов не осталось: ru нет, есть только rd', edit: (w) => { w.projectiles = []; } },
  { label: 'пустая дельта: ничего не изменилось (снарядов нет — нет и без rd)', edit: () => {} },
  {
    label: 'приход: новый игрок, монстр, снаряд и дроп — целиком в дельте',
    edit: (w) => {
      w.players.push({
        id: 'p_77c0', x: 64, y: 96.25, facing: qa(4.5), hp: 120, mana: 200, stamina: 40, alive: true, inCombat: true, stun: false,
        debuffs: { shock: debuff(1, 1759140003000, 0.2) }, toggles: ['guard'],
      });
      w.monsters.push({ id: 42, x: 72.5, y: 80, facing: qa(1), hp: 90, maxHp: 90, alive: true, stun: false, downed: false, debuffs: {}, r: 10, aiState: 'chase' });
      w.projectiles.push({ id: 503, x: 66, y: 97, owner: 'player', dom: 'lightning', r: 5 });
      w.drops.push({ id: 903, x: 70, y: 99.75, kind: 'materials', mats: { 'iron-ingot': 1 } });
    },
  },
  {
    label: 'полный кадр новой области: мир ЗАМЕНЯЕТСЯ, а не сливается со старым',
    full: true,
    edit: (w) => {
      Object.assign(P(w, 'p_1f3a'), { x: 48, y: 48, facing: qa(0.5) });
      Object.assign(P(w, 'p_77c0'), { x: 80, y: 48, facing: qa(0.5), debuffs: {}, toggles: [] });
      w.monsters = [
        { id: 43, x: 400, y: 300, facing: qa(3), hp: 70, maxHp: 70, alive: true, stun: false, downed: false, debuffs: {}, r: 11, aiState: 'idle' },
        { id: 44, x: 420.25, y: 310.5, facing: qa(3.2), hp: 70, maxHp: 70, alive: true, stun: false, downed: false, debuffs: {}, r: 11, aiState: 'idle' },
      ];
      w.projectiles = [];
      w.drops = [];
    },
  },
  {
    label: 'дельта после полного кадра — от нового базиса',
    edit: (w) => {
      P(w, 'p_1f3a').x = 52.25;
      M(w, 43).hp = 64;
      w.projectiles.push({ id: 504, x: 401, y: 299, owner: 'monster', dom: 'poison', r: 7 });
      w.drops.push({ id: 904, x: 395.5, y: 305, kind: 'gold', gold: 5 });
    },
  },
  {
    label: 'снаряд летит — приходит целиком, рядом новый',
    edit: (w) => {
      w.projectiles = [{ id: 504, x: 390.5, y: 298.25, owner: 'monster', dom: 'poison', r: 7 }, { id: 505, x: 52, y: 48, owner: 'player', dom: 'physical', r: 3 }];
    },
  },
];

interface GoldenFrame {
  label: string;
  /** Кадр ровно теми байтами, какими уходит в сеть. */
  hex: string;
  kind: number;
  tick: number;
  /** Сумма из кадра: её обязан воспроизвести порт по СВОЕЙ реконструкции. */
  sum: number;
  players: number;
  monsters: number;
  projectiles: number;
  drops: number;
  /** Мир после кадра, как его собрал веб (`NetClient`): сверять по id, порядок в списках у порта свой. */
  world: WorldSnapshot;
}

/** Веб-клиент без браузера: подделка ровно тех свойств сокета, которыми пользуется `NetClient`. */
class FakeWs {
  static OPEN = 1;
  static last?: FakeWs;
  readyState = 0;
  binaryType = '';
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor() { FakeWs.last = this; }
  send(): void {}
  close(): void {}
}

/** Прогон шагов тем же путём, что `Room.emitShared`, и сбор мира настоящим `NetClient`. */
function produce(): GoldenFrame[] {
  const G = globalThis as unknown as { WebSocket?: unknown };
  const saved = G.WebSocket;
  G.WebSocket = FakeWs;
  try {
    const net = new NetClient();
    const got: { snap?: WorldSnapshot } = {};
    net.on('snapshot', (f) => { got.snap = f.snap; });
    net.connect('ws://golden/ws');
    const ws = FakeWs.last!;
    const delta = new SnapshotDelta();
    let truth = baseWorld();
    const out: GoldenFrame[] = [];
    STEPS.forEach((step, i) => {
      truth = structuredClone(truth);
      truth.tick = 100 + i;
      step.edit(truth);
      const sum = worldChecksum(truth);
      let buf: Uint8Array;
      if (step.full) {
        buf = encodeWorldFrame({ kind: WIRE_FULL, delta: snapshotToDelta(truth), sum });
        delta.prime(truth);
      } else {
        buf = encodeWorldFrame({ kind: WIRE_DELTA, delta: delta.next(truth)!, sum });
      }
      got.snap = undefined;
      ws.onmessage!({ data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
      const snap = got.snap as WorldSnapshot | undefined;   // присвоен обработчиком кадра — сужение TS этого не видит
      if (!snap) throw new Error(`кадр ${i}: веб-клиент не отдал мир`);
      const world = structuredClone(snap);
      out.push({
        label: step.label, hex: Buffer.from(buf).toString('hex'), kind: step.full ? WIRE_FULL : WIRE_DELTA, tick: truth.tick, sum,
        players: world.players.length, monsters: world.monsters.length, projectiles: world.projectiles.length, drops: world.drops.length,
        world,
      });
    });
    net.close();
    return out;
  } finally {
    G.WebSocket = saved;
  }
}

/** Эталон на диск: шапка и по кадру на строку — правка провода видна в диффе покадрово. */
function render(frames: GoldenFrame[]): string {
  const head = {
    note: 'Эталон двоичного кадра мира для порта Unity (R16-05, docs/CRAFT_WEAPONS.md §21.1 К8). Генерит и сторожит '
      + 'packages/client/src/net/unityWireGolden.gen.test.ts; руками не править.',
    rules: [
      'hex — кадр теми байтами, что уходят в сеть (двоичный WebSocket-кадр); kind 1 = полный (применять к ПУСТОМУ миру), 2 = дельта (к своему).',
      'Дельту до первого полного кадра веб пропускает; на смене области копию мира сбрасывает (resetWorld).',
      'world — мир, который из кадра собрал веб: сверять по id (порядок в списках свой); ru нет и rd нет — снарядов нет.',
      'sum — worldChecksum собранного мира, сверять ТОЧНО. JS-арифметика: Math.round — половина вверх (C#: Math.Floor(v*16+0.5)), '
        + '|0 — по модулю 2^32 ((int)(long)x в unchecked), Math.imul(id, 2654435761) — unchecked((int)id * -1640531535), хеш id — по UTF-16 (char).',
      'Угол на проводе: q / 65536 * 2π ровно в этом порядке; posU(q) = q / 4.',
    ],
    frames: '…',
  };
  const lines = frames.map((f) => '  ' + JSON.stringify(f));
  return JSON.stringify(head, null, 1).replace('"frames": "…"', `"frames": [\n${lines.join(',\n')}\n ]`) + '\n';
}

const byId = <T extends { id: unknown }>(xs: readonly T[]): T[] => [...xs].sort((a, b) => String(a.id).localeCompare(String(b.id)));

describe('⭐ R16-05: эталон двоичного кадра мира для Unity (сторож провода)', () => {
  const frames = produce();
  const decoded = frames.map((f) => decodeWorldFrame(new Uint8Array(Buffer.from(f.hex, 'hex'))));

  it('мир веба на каждом кадре сходится с суммой сервера и с истиной (радиус — байтом провода)', () => {
    let truth = baseWorld();
    STEPS.forEach((step, i) => {
      truth = structuredClone(truth);
      truth.tick = 100 + i;
      step.edit(truth);
      const f = frames[i]!;
      expect(worldChecksum(f.world), `кадр ${i} «${f.label}»: сумма`).toBe(f.sum);
      const wireR = (r: number): number => Math.max(0, Math.min(255, Math.round(r)));
      expect(byId(f.world.players), `кадр ${i}: игроки`).toEqual(byId(truth.players));
      expect(byId(f.world.monsters), `кадр ${i}: монстры`).toEqual(byId(truth.monsters.map((m) => ({ ...m, r: wireR(m.r) }))));
      expect(byId(f.world.projectiles), `кадр ${i}: снаряды`).toEqual(byId(truth.projectiles.map((r) => ({ ...r, r: wireR(r.r) }))));
      expect(byId(f.world.drops), `кадр ${i}: дропы`).toEqual(byId(truth.drops));
    });
  });

  it('покрытие: каждое поле маски игрока и монстра — в одиночку, уходы, приход, пустая дельта, два полных кадра', () => {
    const deltas = decoded.filter((f) => f.kind === WIRE_DELTA).map((f) => f.delta);
    const solo = (list: (d: WorldDelta) => { id: unknown }[] | undefined, key: string): boolean =>
      deltas.some((d) => (list(d) ?? []).some((p) => { const k = Object.keys(p); return k.length === 2 && k.includes(key); }));
    for (const key of Object.keys(baseWorld().players[0]!).filter((k) => k !== 'id')) {
      expect(solo((d) => d.pu, key), `игрок: поле ${key} в одиночку`).toBe(true);
    }
    for (const key of Object.keys(baseWorld().monsters[0]!).filter((k) => k !== 'id')) {
      expect(solo((d) => d.mu, key), `монстр: поле ${key} в одиночку`).toBe(true);
    }
    expect(deltas.some((d) => d.pd && d.md && d.rd && d.dd), 'уходы всех четырёх видов').toBe(true);
    expect(deltas.some((d) => !d.ru && d.rd), 'снаряды: только rd').toBe(true);
    expect(deltas.some((d) => !d.pu && !d.pd && !d.mu && !d.md && !d.ru && !d.rd && !d.du && !d.dd), 'пустая дельта').toBe(true);
    expect(deltas.some((d) => d.pu?.some((p) => Object.keys(p).length === Object.keys(baseWorld().players[0]!).length)), 'новый игрок целиком').toBe(true);
    expect(decoded.filter((f) => f.kind === WIRE_FULL)).toHaveLength(2);
    // Полный кадр новой области: у монстров прошлой области нет места в мире — порт, который сливает, их оставит.
    const lastFull = frames.map((f) => f.kind).lastIndexOf(WIRE_FULL);
    expect(frames[lastFull]!.world.monsters.map((m) => m.id)).toEqual([43, 44]);
    expect(frames[lastFull - 1]!.world.monsters.map((m) => m.id)).not.toEqual([43, 44]);
    // Строки вне ASCII (id игрока, JSON предмета), id больше 2^31, HP × 16 больше 2^31.
    expect(frames[0]!.hex).toContain(Buffer.from('игрок-🔥').toString('hex'));
    expect(frames[0]!.hex).toContain(Buffer.from('«Жар» 🔥').toString('hex'));
    expect(frames[0]!.world.monsters.some((m) => m.id > 2 ** 31 && m.hp * 16 > 2 ** 31)).toBe(true);
  });

  it('эталон на диске совпадает с проводом (иначе: провод поменяли — перезаписать -u и отдать порту Unity)', async () => {
    await expect(render(frames), 'провод поменялся: npx vitest run -u packages/client/src/net/unityWireGolden.gen.test.ts, '
      + 'затем скопировать эталон в Assets/DM/Net/Tests/unity_wire_golden.json и догнать порт Unity (docs/CRAFT_WEAPONS.md §21.1, К8)')
      .toMatchFileSnapshot('./__golden__/unity_wire.json');
  });
});
