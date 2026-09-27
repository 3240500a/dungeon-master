import { describe, it, expect } from 'vitest';
import { parseClientFrame, validateInput, parseTownCommand, TOWN_COMMAND_NAMES } from './netSchemas.js';
import type { TownCommand } from './netTypes.js';

/**
 * Валидация кадров клиента (Ф0.6). Главное, что проверяем: в игровое ядро не может попасть
 * ни `NaN`, ни `Infinity`, ни кадр неизвестной формы.
 */
const goodInput = { move: { x: 0.6, y: -0.8 }, facing: 1.2, attack: true, cast: null, interact: false };
/** Токен сессии в настоящем формате: `randomBytes(32).toString('hex')` (R3-14). */
const TOKEN = '0123456789abcdef'.repeat(4);

describe('validateInput', () => {
  it('пропускает корректный ввод', () => {
    const r = validateInput(goodInput);
    expect(r).not.toBeNull();
    expect(r!.facing).toBeCloseTo(1.2, 10);
  });

  it('отбрасывает NaN и Infinity в координатах и во взгляде', () => {
    expect(validateInput({ ...goodInput, move: { x: NaN, y: 0 } })).toBeNull();
    expect(validateInput({ ...goodInput, move: { x: 0, y: Infinity } })).toBeNull();
    expect(validateInput({ ...goodInput, facing: NaN })).toBeNull();
    expect(validateInput({ ...goodInput, facing: -Infinity })).toBeNull();
  });

  it('отбрасывает не-числа там, где ждём числа', () => {
    expect(validateInput({ ...goodInput, move: { x: '1', y: 0 } })).toBeNull();
    expect(validateInput({ ...goodInput, facing: '0' })).toBeNull();
    expect(validateInput({ ...goodInput, move: null })).toBeNull();
    expect(validateInput(null)).toBeNull();
    expect(validateInput('строка')).toBeNull();
  });

  it('отбрасывает неверные флаги и слишком длинный cast', () => {
    expect(validateInput({ ...goodInput, attack: 'да' })).toBeNull();
    expect(validateInput({ ...goodInput, interact: 1 })).toBeNull();
    expect(validateInput({ ...goodInput, cast: 'x'.repeat(65) })).toBeNull();
    expect(validateInput({ ...goodInput, cast: 'x'.repeat(64) })).not.toBeNull();
  });

  it('ограничивает вектор движения единичной длиной', () => {
    const r = validateInput({ ...goodInput, move: { x: 1000, y: 0 } })!;
    expect(Math.hypot(r.move.x, r.move.y)).toBeCloseTo(1, 10);
    // короткий вектор (аналоговый стик) не растягивается
    const half = validateInput({ ...goodInput, move: { x: 0.3, y: 0 } })!;
    expect(half.move.x).toBeCloseTo(0.3, 10);
  });

  it('проверяет диапазон слота пояса', () => {
    expect(validateInput({ ...goodInput, useBelt: -1 })).toBeNull();
    expect(validateInput({ ...goodInput, useBelt: 99 })).toBeNull();
    expect(validateInput({ ...goodInput, useBelt: 1.5 })).toBeNull();
    expect(validateInput({ ...goodInput, useBelt: 3 })!.useBelt).toBe(3);
  });

  /**
   * ⚠ R7-01: ОГРОМНЫЙ, НО КОНЕЧНЫЙ ВЗГЛЯД. `1e17` проходил «конечное число» и уезжал в ядро как есть, а `wrapAngle` на таких
   * величинах точности не имеет и отдаёт 0 для любой разницы углов: каждый взмах бил по кругу 360° (и в PvP — в спину).
   * Не отказ, а приведение: Unity и прочие клиенты вправе слать неприведённый угол.
   */
  it('⭐ R7-01: взгляд любой конечной величины приводится в [−π, π] — тем же направлением', () => {
    for (const f of [1e17, -1e17, 1e20, 1e300, -1e300, 2 ** 60, 7, -4, 1e6]) {
      const r = validateInput({ ...goodInput, facing: f });
      expect(r, `${f}`).not.toBeNull();
      expect(Math.abs(r!.facing), `${f}`).toBeLessThanOrEqual(Math.PI);
      expect(r!.facing, `${f}`).toBe(Math.atan2(Math.sin(f), Math.cos(f)));
    }
    // Честный взгляд (`atan2` клиента) — бит в бит прежний.
    for (const f of [0, 1.2, -3, Math.PI, -Math.PI]) expect(validateInput({ ...goodInput, facing: f })!.facing).toBe(f);
    // И тот же путь у кадра целиком.
    const fr = parseClientFrame(JSON.stringify({ t: 'input', seq: 1, input: { ...goodInput, facing: 1e17 } }));
    expect(fr?.t === 'input' && Math.abs(fr.input.facing)).toBeLessThanOrEqual(Math.PI);
  });
});

describe('parseClientFrame', () => {
  it('разбирает ввод', () => {
    const f = parseClientFrame(JSON.stringify({ t: 'input', seq: 5, input: goodInput }));
    expect(f?.t).toBe('input');
  });

  it('отбрасывает ввод с битым seq или содержимым', () => {
    expect(parseClientFrame(JSON.stringify({ t: 'input', seq: NaN, input: goodInput }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: 'input', seq: 1, input: { ...goodInput, facing: NaN } }))).toBeNull();
  });

  it('разбирает join и требует токен с charId', () => {
    expect(parseClientFrame(JSON.stringify({ t: 'join', token: TOKEN, charId: 'c1', fresh: true }))?.t).toBe('join');
    expect(parseClientFrame(JSON.stringify({ t: 'join', charId: 'c1' }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: 'join', token: '', charId: 'c1' }))).toBeNull();
  });

  it('разбирает команды города и отбрасывает неизвестные', () => {
    expect(parseClientFrame(JSON.stringify({ t: 'cmd', command: { cmd: 'buy', uid: 'it_1' } }))?.t).toBe('cmd');
    expect(parseClientFrame(JSON.stringify({ t: 'cmd', command: { cmd: 'нет-такой', uid: 'x' } }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: 'cmd', command: { cmd: 'moveItem', uid: 'i', x: -5, y: 0 } }))).toBeNull();
  });

  it('отбрасывает мусор и неизвестные типы кадров', () => {
    expect(parseClientFrame('не json')).toBeNull();
    expect(parseClientFrame('null')).toBeNull();
    expect(parseClientFrame('[]')).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: 'выключи-сервер' }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: 'ping', id: 'нет' }))).toBeNull();
  });

  it('ограничивает длину строковых полей', () => {
    expect(parseClientFrame(JSON.stringify({ t: 'join', token: 'x'.repeat(300), charId: 'c' }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({ t: 'cmd', command: { cmd: 'buy', uid: 'x'.repeat(100) } }))).toBeNull();
  });

  it('знает кадр сундука этажа', () => {
    expect(parseClientFrame(JSON.stringify({ t: 'chest', chestId: 3 }))?.t).toBe('chest');
    expect(parseClientFrame(JSON.stringify({ t: 'chest', chestId: -1 }))).toBeNull();
  });
});

/**
 * Команды города (D11): сервер разбирает их ЭТОЙ схемой перед исполнением, поэтому она обязана
 * знать каждую команду протокола и не пропускать ничего сверх описанного.
 */
describe('схема команд города', () => {
  /**
   * ⭐ ПОЛНОТА. Запись с ключами РОВНО из `TownCommand['cmd']`: забытая команда — ошибка сборки
   * («не хватает свойства»), лишняя — тоже («лишнее свойство»). Тест сверяет её со схемой.
   */
  const EVERY: Record<TownCommand['cmd'], true> = {
    buy: true, sell: true, forgeUpgrade: true, forgeReroll: true, forgeRepair: true, depositMaterials: true,
    forgeSalvage: true, craft: true, forgeEnchant: true, forgeSketch: true, salvage: true, equip: true, unequip: true, allocAttr: true, respec: true,
    respecPassives: true, respecSkills: true, allocPassive: true, allocSkill: true, socketInsert: true,
    socketClear: true, useConsumable: true, moveBelt: true, moveItem: true, stashOpen: true, stashMove: true,
    bind: true, pickup: true, drop: true, acceptQuest: true, turnInQuest: true,
  };

  it('⭐ дискриминаторы схемы РОВНО совпадают с TownCommand[cmd]', () => {
    expect([...TOWN_COMMAND_NAMES].sort()).toEqual(Object.keys(EVERY).sort());
    expect(new Set(TOWN_COMMAND_NAMES).size, 'без повторов').toBe(TOWN_COMMAND_NAMES.length);
  });

  it('пропускает то, что шлёт честный клиент', () => {
    const good: TownCommand[] = [
      { cmd: 'buy', uid: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' },
      { cmd: 'unequip', slot: 'weapon' },
      { cmd: 'socketInsert', nodeId: 'n1', slot: 0, insertId: 'fire' },
      { cmd: 'moveItem', uid: 'a', x: 3, y: 2 },
      { cmd: 'stashMove', uid: 'a', dst: 'inv', x: 0, y: 0 },
      { cmd: 'stashMove', uid: 'a', dst: 1, x: 19, y: 11 },
      { cmd: 'bind', slot: 0, value: null },
      { cmd: 'bind', slot: 4, value: 'attack' },
      { cmd: 'pickup', dropId: 17 },
      { cmd: 'respec' },
    ];
    for (const c of good) expect(parseTownCommand(c), JSON.stringify(c)).toEqual({ ok: true, command: c });
  });

  it('⭐ СТРОГО: лишний ключ — отказ целиком, даже если остальное верно', () => {
    const r = parseTownCommand({ cmd: 'buy', uid: 'a', price: 0 });
    expect(r.ok).toBe(false);
    expect(parseTownCommand({ cmd: 'respec', all: true }).ok).toBe(false);
    expect(parseTownCommand({ cmd: 'stashMove', uid: 'a', dst: 'inv', x: 0, y: 0, tab: 1 }).ok).toBe(false);
  });

  it('не тот тип, битая вложенность, мусор — отказ с путём к полю (для лога)', () => {
    const wrongType = parseTownCommand({ cmd: 'moveItem', uid: 'a', x: '1', y: 0 });
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) expect(wrongType.error).toMatch(/^x:/);
    expect(parseTownCommand({ cmd: 'stashMove', uid: 'a', dst: { tab: 1 }, x: 0, y: 0 }).ok).toBe(false);
    expect(parseTownCommand({ cmd: 'bind', slot: 1.5, value: null }).ok).toBe(false);
    expect(parseTownCommand({ cmd: 'buy', uid: '' }).ok, 'пустой uid').toBe(false);
    expect(parseTownCommand({ cmd: 'buy' }).ok, 'нет обязательного поля').toBe(false);
    for (const junk of [null, undefined, 7, 'buy', [], {}, { cmd: 42 }, { cmd: 'нет-такой' }]) {
      expect(parseTownCommand(junk).ok, JSON.stringify(junk) ?? 'undefined').toBe(false);
    }
  });

  it('⚠ R2-15: очки атрибутов пачкой — `n` целое 1…1000; без `n` — одно очко, как шлёт Unity', () => {
    for (const c of [
      { cmd: 'allocAttr', attr: 'strength' }, { cmd: 'allocAttr', attr: 'strength', n: 1 }, { cmd: 'allocAttr', attr: 'vitality', n: 1000 },
    ] as TownCommand[]) expect(parseTownCommand(c), JSON.stringify(c)).toEqual({ ok: true, command: c });
    for (const n of [0, -1, 1.5, 1001, '5', null, Number.NaN]) {
      expect(parseTownCommand({ cmd: 'allocAttr', attr: 'strength', n }).ok, String(n)).toBe(false);
    }
  });

  it('⭐ R11-02: `equip` с целью — только вторая рука (дуал-вилд); без цели — родной слот, как шлют меню и Unity', () => {
    for (const c of [{ cmd: 'equip', uid: 'u1' }, { cmd: 'equip', uid: 'u1', slot: 'offhand' }] as TownCommand[]) {
      expect(parseTownCommand(c), JSON.stringify(c)).toEqual({ ok: true, command: c });
    }
    for (const slot of ['weapon', 'helm', 'OFFHAND', '', null, 1, ['offhand']]) {
      expect(parseTownCommand({ cmd: 'equip', uid: 'u1', slot }).ok, JSON.stringify(slot)).toBe(false);
    }
  });
});

/**
 * ⭐ КОВКА НА ПРОВОДЕ (D2/D11). Заявка — единственная команда с глубокой вложенностью, и каждый её уровень
 * строгий: сервер отдаёт в ядро только то, что прошло схему, а ядро пересобирает заявку ещё раз.
 */
describe('схема ковки и зачарования', () => {
  type Draft = Record<string, unknown> & { input: Record<string, unknown> & { parts: Record<string, unknown> } };
  const pick = (id: string, step: unknown = 2): { id: string; step: unknown } => ({ id, step });
  const craft = (patch: (c: Draft) => void = () => {}): Draft => {
    const c: Draft = {
      cmd: 'craft', nonce: 'nonce-0001',
      input: { weaponClass: 'sword', hands: 1, parts: { strike: pick('blade-a'), grip: pick('grip-a'), bind: pick('bind-a'), head: pick('head-a') } },
    };
    patch(c);
    return c;
  };

  it('пропускает честную заявку — с доводкой и без, на любой ступени лестницы', () => {
    for (const step of [1, 2, 3, 4, 5]) {
      const c = craft((x) => { for (const s of ['strike', 'grip', 'bind', 'head']) x.input.parts[s] = pick(`${s}-a`, step); });
      expect(parseTownCommand(c), `ступень ${step}`).toEqual({ ok: true, command: c });
    }
    const withFinish = craft((x) => { x.input.finish = 2; });
    expect(parseTownCommand(withFinish)).toEqual({ ok: true, command: withFinish });
    expect(parseTownCommand(craft((x) => { x.input.hands = 2; })).ok, 'двуручное').toBe(true);
    for (const nonce of ['abcdefgh', 'A_b-9'.repeat(4), 'x'.repeat(64)]) {
      expect(parseTownCommand(craft((x) => { x.nonce = nonce; })).ok, nonce).toBe(true);
    }
  });

  it('⭐ отказ на КАЖДОМ нарушении заявки — ни одно не доезжает до ядра', () => {
    const bad: [string, Draft][] = [
      ['лишний ключ команды', craft((x) => { x.price = 0; })],
      ['лишний ключ заявки', craft((x) => { x.input.tier = 6; })],
      ['пятое гнездо', craft((x) => { x.input.parts.pommel = pick('p'); })],
      ['нет гнезда', craft((x) => { delete x.input.parts.head; })],
      ['гнездо не объект', craft((x) => { x.input.parts.grip = 'grip-a'; })],
      ['лишний ключ детали', craft((x) => { x.input.parts.strike = { id: 'blade-a', step: 2, material: 'iron-5' }; })],
      ['нет ступени', craft((x) => { x.input.parts.strike = { id: 'blade-a' }; })],
      ['ступень 0', craft((x) => { x.input.parts.strike = pick('blade-a', 0); })],
      ['ступень 6', craft((x) => { x.input.parts.strike = pick('blade-a', 6); })],
      ['ступень дробная', craft((x) => { x.input.parts.bind = pick('bind-a', 2.5); })],
      ['ступень строкой', craft((x) => { x.input.parts.bind = pick('bind-a', '2'); })],
      ['ступень NaN', craft((x) => { x.input.parts.bind = pick('bind-a', NaN); })],
      ['ступень ∞', craft((x) => { x.input.parts.bind = pick('bind-a', Infinity); })],
      ['пустой id детали', craft((x) => { x.input.parts.head = pick(''); })],
      ['длинный id детали', craft((x) => { x.input.parts.head = pick('x'.repeat(65)); })],
      ['хват 0', craft((x) => { x.input.hands = 0; })],
      ['хват 3', craft((x) => { x.input.hands = 3; })],
      ['хват дробный', craft((x) => { x.input.hands = 1.5; })],
      ['хват строкой', craft((x) => { x.input.hands = '1'; })],
      ['пустой класс', craft((x) => { x.input.weaponClass = ''; })],
      ['длинный класс', craft((x) => { x.input.weaponClass = 'x'.repeat(65); })],
      ['класс числом', craft((x) => { x.input.weaponClass = 7; })],
      ['доводка −1', craft((x) => { x.input.finish = -1; })],
      ['доводка дробная', craft((x) => { x.input.finish = 1.5; })],
      ['доводка за рамкой', craft((x) => { x.input.finish = 32; })],
      ['доводка строкой', craft((x) => { x.input.finish = '0'; })],
      ['доводка null', craft((x) => { x.input.finish = null; })],
      ['заявка null', craft((x) => { (x as Record<string, unknown>).input = null; })],
      ['заявка массив', craft((x) => { (x as Record<string, unknown>).input = []; })],
      ['нет заявки', craft((x) => { delete (x as Record<string, unknown>).input; })],
      ['ключ короткий', craft((x) => { x.nonce = 'short12'; })],
      ['ключ длинный', craft((x) => { x.nonce = 'x'.repeat(65); })],
      ['ключ с пробелом', craft((x) => { x.nonce = 'nonce 0001'; })],
      ['ключ кириллицей', craft((x) => { x.nonce = 'ключзаявки'; })],
      ['ключ с переводом строки', craft((x) => { x.nonce = 'nonce-0001\n'; })],
      ['ключ числом', craft((x) => { x.nonce = 12345678; })],
      ['нет ключа', craft((x) => { delete x.nonce; })],
    ];
    for (const [why, c] of bad) expect(parseTownCommand(c).ok, why).toBe(false);
  });

  it('⚠ ключ `__proto__` из JSON — отказ на любом уровне, прототип не тронут', () => {
    const honest = JSON.stringify(craft());
    const texts = [
      honest.replace('"cmd":', '"__proto__":{"polluted":1},"cmd":'),
      honest.replace('"weaponClass":', '"__proto__":{"polluted":1},"weaponClass":'),
      honest.replace('"strike":', '"__proto__":{"step":5},"strike":'),
      honest.replace('"id":"blade-a"', '"__proto__":{"x":1},"id":"blade-a"'),
    ];
    for (const t of texts) {
      expect(t, 'подмена сработала').not.toBe(honest);
      expect(parseTownCommand(JSON.parse(t) as unknown).ok, t).toBe(false);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('разобранная заявка — СВЕЖИЙ объект: правка присланного после разбора её не меняет', () => {
    const sent = craft();
    const r = parseTownCommand(sent);
    expect(r.ok).toBe(true);
    sent.input.parts.strike = pick('blade-a', 5);
    (sent.input.parts.grip as { step: number }).step = 5;
    if (r.ok && r.command.cmd === 'craft') {
      expect(r.command.input.parts.strike.step).toBe(2);
      expect(r.command.input.parts.grip.step).toBe(2);
    }
  });

  it('зачарование: только магическая или редкая, строго', () => {
    expect(parseTownCommand({ cmd: 'forgeEnchant', uid: 'u1', rarity: 'magic' }).ok).toBe(true);
    expect(parseTownCommand({ cmd: 'forgeEnchant', uid: 'u1', rarity: 'rare' }).ok).toBe(true);
    for (const bad of [
      { cmd: 'forgeEnchant', uid: 'u1', rarity: 'normal' },
      { cmd: 'forgeEnchant', uid: 'u1', rarity: 'unique' },
      { cmd: 'forgeEnchant', uid: 'u1', rarity: 'legendary' },
      { cmd: 'forgeEnchant', uid: 'u1', rarity: 'MAGIC' },
      { cmd: 'forgeEnchant', uid: 'u1' },
      { cmd: 'forgeEnchant', uid: '', rarity: 'magic' },
      { cmd: 'forgeEnchant', uid: 'x'.repeat(65), rarity: 'magic' },
      { cmd: 'forgeEnchant', uid: 'u1', rarity: 'magic', affixes: ['x'] },
      { cmd: 'forgeEnchant', uid: 'u1', rarity: 1 },
    ]) expect(parseTownCommand(bad).ok, JSON.stringify(bad)).toBe(false);
  });
});

/**
 * ⭐ R3-02 / R3-14: СТРОКА С ПРОВОДА — БЕЗ U+0000 И НЕПАРНЫХ СУРРОГАТОВ. JSON их пропускает (`"\\u0000"`, `"\\ud800"`),
 * zod по длине — тоже, а Postgres — нет: jsonb отвергает U+0000 (22P05) и непарный суррогат (22P02), текстовый
 * параметр — байт 0x00 (22021). Бинд `"x\\u0000"` ложился в сейв, и КАЖДАЯ следующая запись героя падала: он играл
 * из памяти, а рестарт откатывал его к сейву до бинда — дюп через соседа по аккаунту и откат неудачных бросков.
 * Кадр лобби с тем же символом в токене бил в базу на каждом кадре и ронял лог без ответа клиенту.
 */
describe('⚠ R3-02 / R3-14: строки провода без U+0000 и непарных суррогатов', () => {
  const NUL = String.fromCharCode(0);
  const LONE_HI = String.fromCharCode(0xd800);
  const LONE_LO = String.fromCharCode(0xdc00);
  const BAD = [NUL, LONE_HI, LONE_LO, String.fromCharCode(0x1f), String.fromCharCode(0x7f)];
  type Path = (string | number)[];
  /** Пути ко всем строковым листьям объекта. */
  const stringPaths = (v: unknown, at: Path = []): Path[] => {
    if (typeof v === 'string') return [at];
    if (Array.isArray(v)) return v.flatMap((x, i) => stringPaths(x, [...at, i]));
    if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => stringPaths(x, [...at, k]));
    return [];
  };
  /** Копия с заменённым листом. */
  const withLeaf = <T>(root: T, path: Path, patch: (s: string) => string): T => {
    const copy = structuredClone(root) as Record<string | number, unknown>;
    let o = copy;
    for (const k of path.slice(0, -1)) o = o[k] as Record<string | number, unknown>;
    const last = path[path.length - 1]!;
    o[last] = patch(o[last] as string);
    return copy as T;
  };
  const pick = (id: string): { id: string; step: number } => ({ id, step: 2 });
  /** По команде на каждую форму: вместе они держат КАЖДОЕ строковое поле схемы. */
  const honest: TownCommand[] = [
    { cmd: 'buy', uid: 'u1' }, { cmd: 'sell', uid: 'u1' }, { cmd: 'forgeUpgrade', uid: 'u1' }, { cmd: 'forgeReroll', uid: 'u1' },
    { cmd: 'forgeSalvage', uid: 'u1' }, { cmd: 'forgeRepair', uid: 'u1' },
    { cmd: 'craft', nonce: 'nonce-0001', input: { weaponClass: 'sword', hands: 1, parts: { strike: pick('blade-a'), grip: pick('grip-a'), bind: pick('bind-a'), head: pick('head-a') } } },
    { cmd: 'forgeEnchant', uid: 'u1', rarity: 'magic' }, { cmd: 'forgeSketch', variantId: 'blade-a' },
    { cmd: 'salvage', uid: 'u1' }, { cmd: 'equip', uid: 'u1' }, { cmd: 'equip', uid: 'u1', slot: 'offhand' }, { cmd: 'unequip', slot: 'weapon' },
    { cmd: 'allocAttr', attr: 'strength' }, { cmd: 'allocPassive', nodeId: 'n1' }, { cmd: 'allocSkill', nodeId: 'n1' },
    { cmd: 'socketInsert', nodeId: 'n1', slot: 0, insertId: 'fire' }, { cmd: 'socketClear', nodeId: 'n1', slot: 0 },
    { cmd: 'useConsumable', uid: 'u1' }, { cmd: 'moveBelt', uid: 'u1' }, { cmd: 'moveItem', uid: 'u1', x: 0, y: 0 },
    { cmd: 'stashMove', uid: 'u1', dst: 'inv', x: 0, y: 0 }, { cmd: 'bind', slot: 4, value: 'attack' }, { cmd: 'drop', uid: 'u1' },
    { cmd: 'acceptQuest', questId: 'rnd_rnd-delve_x1' }, { cmd: 'turnInQuest', questId: 'main-1' },
  ];

  it('⭐ каждое строковое поле каждой команды: U+0000, непарный суррогат, управляющий символ — «Неверная команда»', () => {
    let n = 0;
    for (const c of honest) {
      expect(parseTownCommand(c), JSON.stringify(c)).toEqual({ ok: true, command: c });
      for (const path of stringPaths(c)) {
        if (path.length === 1 && path[0] === 'cmd') continue;   // дискриминатор — литерал, его и так не подменить
        for (const bad of BAD) for (const place of ['end', 'only'] as const) {
          const cmd = withLeaf(c, path, (s) => (place === 'end' ? s + bad : bad));
          expect(parseTownCommand(cmd).ok, `${c.cmd} ${path.join('.')} +${bad.charCodeAt(0).toString(16)} (${place})`).toBe(false);
          n++;
        }
      }
    }
    expect(n, 'сторож обошёл все строковые поля').toBeGreaterThan(250);
  });

  it('то же — через разбор настоящего кадра: JSON-экран `\\u0000` превращается в символ и отвергается', () => {
    const frame = (value: string): string => JSON.stringify({ t: 'cmd', id: 1, command: { cmd: 'bind', slot: 4, value } });
    expect(frame(`x${NUL}`)).toContain('\\u0000');   // на проводе — экран, не сырой байт
    expect(parseClientFrame(frame('attack'))?.t).toBe('cmd');
    for (const bad of BAD) expect(parseClientFrame(frame(`x${bad}`)), bad.charCodeAt(0).toString(16)).toBeNull();
    expect(parseTownCommand({ cmd: 'bind', slot: 4, value: null }).ok, 'пустой бинд — null').toBe(true);
  });

  it('парный суррогат — обычный символ (не отказ по форме): решает смысл поля, а не схема', () => {
    const smile = String.fromCodePoint(0x1f600);
    expect(parseTownCommand({ cmd: 'buy', uid: `a${smile}` }).ok).toBe(true);
    expect(parseTownCommand({ cmd: 'buy', uid: `a${smile.slice(0, 1)}` }).ok, 'половинка — отказ').toBe(false);
  });

  it('⭐ R3-14: кадры лобби — токен ровно 64 hex, charId — [A-Za-z0-9_-]; U+0000 не доезжает до базы', () => {
    const uuid = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    for (const t of ['join', 'runStatus', 'abandon'] as const) {
      expect(parseClientFrame(JSON.stringify({ t, token: TOKEN, charId: uuid }))?.t, t).toBe(t);
      expect(parseClientFrame(JSON.stringify({ t, token: TOKEN, charId: 'char-rm_1' }))?.t, `${t}: старый вид id`).toBe(t);
      for (const token of ['abc', TOKEN.toUpperCase(), `${TOKEN}0`, TOKEN.slice(1), `${TOKEN.slice(1)}${NUL}`, `a${NUL}`, `${TOKEN.slice(1)}g`]) {
        expect(parseClientFrame(JSON.stringify({ t, token, charId: uuid })), `${t} token ${JSON.stringify(token)}`).toBeNull();
      }
      for (const charId of [`x${NUL}`, `${uuid.slice(1)}${LONE_HI}`, 'a b', 'a/b', 'персонаж', 'x'.repeat(65), '']) {
        expect(parseClientFrame(JSON.stringify({ t, token: TOKEN, charId })), `${t} charId ${JSON.stringify(charId)}`).toBeNull();
      }
    }
  });

  it('прочие строки кадров (код комнаты, сложность, узел, выбор алтаря) — тоже без U+0000 и суррогатов', () => {
    const frames: Record<string, unknown>[] = [
      { t: 'join', token: TOKEN, charId: 'c1', roomCode: 'AB12C' },
      { t: 'descend', difficultyId: 'normal', targetNodeId: 'n2_0', runConfig: { biomeId: 'crypt', templateId: 'default', modifiers: ['m1'] } },
    ];
    for (const f of frames) {
      expect(parseClientFrame(JSON.stringify(f)), JSON.stringify(f)).not.toBeNull();
      for (const path of stringPaths(f)) {
        if (path[0] === 't' || path[0] === 'token' || path[0] === 'charId') continue;
        for (const bad of [NUL, LONE_HI]) {
          expect(parseClientFrame(JSON.stringify(withLeaf(f, path, (s) => s + bad))), `${f.t} ${path.join('.')}`).toBeNull();
        }
      }
    }
  });
});

describe('⚠ R6-13: согласие на замену начатого задания доски', () => {
  it('`replace` — только `true`; без него команда та же, что прежде', () => {
    expect(parseTownCommand({ cmd: 'acceptQuest', questId: 'rnd_rnd-cull_a1' }).ok).toBe(true);
    expect(parseTownCommand({ cmd: 'acceptQuest', questId: 'rnd_rnd-cull_a1', replace: true }).ok).toBe(true);
    for (const bad of [false, 'yes', 1, null]) expect(parseTownCommand({ cmd: 'acceptQuest', questId: 'rnd_rnd-cull_a1', replace: bad }).ok, String(bad)).toBe(false);
  });
});
