import { describe, it, expect } from 'vitest';
import {
  CRAFT_NONCES_KEEP, CRAFT_NONCE_RE, ConfigRegistry, craftAction, createRng, defaultParts, emptyStash, fullJournal, materialItem,
  newBotSave, parseTownCommand, type AccountStash, type CraftInput, type SaveState, type TownCommand,
} from '@dm/shared';
import type { CmdReply } from '../../net/cmdReplies.js';
import {
  CRAFT_OPEN_KEEP, CRAFT_UNKNOWN, craftSig, findOwned, gameCraftHost, newCraftNonce, wireInput, type CraftMemo, type ForgeLink,
} from './craftHost.js';
import type { CraftReply } from './craftPanel.js';

/**
 * ⭐ ИГРОВОЙ ХОЗЯИН ОКНА КОВКИ (К4). Он ничего не решает — решает сервер, — но от него зависит, что
 * заявка уходит РОВНО ОДНА и повтор идёт ТЕМ ЖЕ ключом. Здесь стережётся:
 * - в полёте вторая команда не уходит вовсе;
 * - нет ответа → «неизвестно», повтор той же сборки — тот же `nonce`; успех → ключ сгорает;
 * - заявка на провод — чистая, проходит строгую схему сервера;
 * - ⭐ сквозной прогон с НАСТОЯЩИМ ядром сервера (`craftAction`): ответ потерян после ковки → повтор →
 *   одна вещь и одно списание.
 */

const reg = (() => { const r = new ConfigRegistry(); r.loadAll(); return r; })();
const INPUT: CraftInput = { weaponClass: 'sword', hands: 1, parts: defaultParts(reg, 'sword', 1, 2)!, finish: 0 };
const OTHER: CraftInput = { ...INPUT, finish: 1 };
const fullWallet = (): Record<string, number> => Object.fromEntries(reg.get('craft-materials').map((m) => [m.id, 500]));

function heroSave(gold = 1_000_000): SaveState {
  const s = newBotSave(reg, reg.get('classes')[0]!.id);
  s.gold = gold;
  return s;
}

type Answer = (cmd: TownCommand) => CmdReply | null | Promise<CmdReply | null>;
/** Поддельная связь: что ушло на сервер и что он ответил. */
function fakeLink(answer: Answer, save = heroSave(), stash: AccountStash = { ...emptyStash(reg), materials: fullWallet(), forgeJournal: fullJournal(reg) }) {
  const sent: TownCommand[] = [];
  const link: ForgeLink & { net: { connected: boolean } } = {
    config: reg,
    state: { save },
    stash: { materials: stash.materials ?? {}, forgeJournal: stash.forgeJournal },
    net: { connected: true },
    request: async (cmd) => { sent.push(structuredClone(cmd)); return answer(cmd); },
  };
  return { link, sent, save, stash };
}
const memo = (): CraftMemo => ({ open: new Map(), busy: false });
const ok = (over: Partial<CmdReply> = {}): CmdReply => ({ t: 'cmdResult', id: 1, cmd: 'craft', ok: true, ...over });
const craftCmd = (c: TownCommand | undefined): Extract<TownCommand, { cmd: 'craft' }> => {
  if (c?.cmd !== 'craft') throw new Error(`ждали craft, ушло ${c?.cmd}`);
  return c;
};

describe('ключ заявки и заявка на провод', () => {
  it('ключ — под правило сервера (CRAFT_NONCE_RE) и каждый раз новый', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const n = newCraftNonce();
      expect(n).toMatch(CRAFT_NONCE_RE);
      seen.add(n);
    }
    expect(seen.size).toBe(200);
  });

  it('⭐ лишние ключи состояния окна до провода не доезжают — строгая схема сервера заявку принимает', () => {
    const dirty = {
      ...INPUT, crafted: { uid: 'x' }, message: 'hi',
      parts: Object.fromEntries(Object.entries(INPUT.parts).map(([k, v]) => [k, { ...v, lore: 'лишнее' }])),
    } as unknown as CraftInput;
    expect(parseTownCommand({ cmd: 'craft', nonce: newCraftNonce(), input: dirty }).ok).toBe(false);
    const clean = wireInput(dirty);
    expect(parseTownCommand({ cmd: 'craft', nonce: newCraftNonce(), input: clean }).ok).toBe(true);
    expect(clean).toEqual(INPUT);
  });

  it('подпись сборки: доводка без значения = 0, порядок гнёзд не важен', () => {
    const { finish: _f, ...noFinish } = INPUT;
    expect(craftSig(noFinish)).toBe(craftSig(INPUT));
    const reversed = { ...INPUT, parts: Object.fromEntries(Object.entries(INPUT.parts).reverse()) } as CraftInput;
    expect(craftSig(reversed)).toBe(craftSig(INPUT));
    expect(craftSig(OTHER)).not.toBe(craftSig(INPUT));
  });
});

describe('⭐ gameCraftHost — одна заявка, тот же ключ на повтор', () => {
  it('ковка уходит командой craft; успех → вещь берётся из сейва по uid ответа', async () => {
    const save = heroSave();
    const item = { ...save.equipment.weapon!, uid: 'crafted-1', pos: { x: 0, y: 0 } };
    save.inventory.push(item);
    const { link, sent } = fakeLink(() => ok({ uid: 'crafted-1' }), save);
    const r = await gameCraftHost(link, memo()).craft(INPUT);
    expect(r).toMatchObject({ ok: true, item: { uid: 'crafted-1' } });
    expect(sent).toHaveLength(1);
    expect(craftCmd(sent[0]).nonce).toMatch(CRAFT_NONCE_RE);
  });

  it('⭐ пока заявка в полёте, вторая НЕ уходит — ни с того же окна, ни с заново открытого', async () => {
    let release!: (r: CmdReply | null) => void;
    const { link, sent } = fakeLink(() => new Promise((res) => { release = res; }));
    const m = memo();
    const first = gameCraftHost(link, m).craft(INPUT) as Promise<CraftReply>;
    const again = await gameCraftHost(link, m).craft(INPUT);           // «заново открытое» окно — новый хозяин, та же память
    const enchant = await gameCraftHost(link, m).enchant({ uid: 'x' } as never, 'magic');
    expect(again.ok).toBe(false);
    expect(enchant.ok).toBe(false);
    expect(sent).toHaveLength(1);
    release(ok({ uid: 'nope' }));
    await first;
    expect(m.busy).toBe(false);
  });

  it('⭐ нет ответа → «неизвестно»; повтор ТОЙ ЖЕ сборки — тот же ключ; успех → ключ сгорает', async () => {
    const replies: (CmdReply | null)[] = [null, ok({ ok: false, reason: 'Не удалось сохранить, попробуйте ещё раз' }), ok({ uid: 'u1' }), ok({ uid: 'u2' })];
    const { link, sent } = fakeLink(() => replies.shift() ?? null);
    const host = gameCraftHost(link, memo());
    const r1 = await host.craft(INPUT);
    expect(r1).toMatchObject({ ok: false, unknown: true, reason: CRAFT_UNKNOWN });
    const r2 = await host.craft(INPUT);                                  // отказ сервера — тоже без подтверждения
    expect(r2).toMatchObject({ ok: false, reason: 'Не удалось сохранить, попробуйте ещё раз' });
    const r3 = await host.craft(INPUT);
    expect(r3.ok).toBe(true);
    await host.craft(INPUT);                                             // после успеха — новая вещь, новый ключ
    const nonces = sent.map((c) => craftCmd(c).nonce);
    expect(nonces[0]).toBe(nonces[1]);
    expect(nonces[1]).toBe(nonces[2]);
    expect(nonces[3]).not.toBe(nonces[2]);
  });

  it('сменил сборку после «неизвестно» — это другая заявка, новый ключ', async () => {
    const { link, sent } = fakeLink(() => null);
    const host = gameCraftHost(link, memo());
    await host.craft(INPUT);
    await host.craft(OTHER);
    await host.craft(OTHER);
    const [a, b, c] = sent.map((x) => craftCmd(x).nonce);
    expect(a).not.toBe(b);
    expect(b).toBe(c);
  });

  /**
   * ⭐ R2-33: ключ держался ОДНИМ слотом — попробовал другую сборку (или сменил доводку) после «нет ответа», и ключ
   * первой сгорал; вернулся к ней — новый ключ, и сервер, уже сковавший её молча, ковал вторую и списывал дважды.
   * Хотя окно обещало (CRAFT_UNKNOWN): «повтор той же заявки не скуёт вторую вещь».
   */
  it('⭐ R2-33: A без ответа → B успех → снова A — ключ первой заявки A, а не новый', async () => {
    const replies: (CmdReply | null)[] = [null, ok({ uid: 'b1' }), ok({ uid: 'a1' })];
    const { link, sent } = fakeLink(() => replies.shift() ?? null);
    const host = gameCraftHost(link, memo());
    await host.craft(INPUT);
    await host.craft(OTHER);
    await host.craft(INPUT);
    const [a1, b, a2] = sent.map((c) => craftCmd(c).nonce);
    expect(b).not.toBe(a1);
    expect(a2, 'возврат к A — тот же ключ').toBe(a1);
  });

  it('⭐ R2-33: сборка, нажатая без связи, ключ ждущей заявки не трогает; подтверждённый успех гасит только свой', async () => {
    const replies: (CmdReply | null)[] = [null, null, ok({ uid: 'a1' }), ok({ uid: 'b1' }), ok({ uid: 'a2' })];
    const { link, sent } = fakeLink(() => replies.shift() ?? null);
    const host = gameCraftHost(link, memo());
    await host.craft(INPUT);                       // A — нет ответа
    link.net.connected = false;
    await host.craft({ ...INPUT, finish: 2 });     // без связи — ничего не ушло
    link.net.connected = true;
    await host.craft(OTHER);                       // B — нет ответа
    await host.craft(INPUT);                       // A — успех: ключ A сгорел
    await host.craft(OTHER);                       // B — тот же ключ B
    await host.craft(INPUT);                       // A — новая вещь, новый ключ
    const [a1, b1, a2, b2, a3] = sent.map((c) => craftCmd(c).nonce);
    expect(sent).toHaveLength(5);
    expect(a2).toBe(a1);
    expect(b2).toBe(b1);
    expect(a3).not.toBe(a1);
    expect(a3).not.toBe(b1);
  });

  it('R2-33: ключ — по герою: другой герой аккаунта той же сборкой шлёт свой ключ; вернулся — прежний', async () => {
    const { link, sent, save } = fakeLink(() => null);
    const host = gameCraftHost(link, memo());
    const hero = save.charId;
    await host.craft(INPUT);
    save.charId = `${hero}-alt`;
    await host.craft(INPUT);
    save.charId = hero;
    await host.craft(INPUT);
    const [a, b, c] = sent.map((x) => craftCmd(x).nonce);
    expect(b, 'чужой ключ сервер счёл бы повтором и ответил бы вещью другого героя').not.toBe(a);
    expect(c).toBe(a);
  });

  it('R2-33: ключей без подтверждения помним не больше CRAFT_OPEN_KEEP — старейший вытесняется', async () => {
    const { link, sent } = fakeLink(() => null);
    const m = memo();
    const host = gameCraftHost(link, m);
    const builds = Array.from({ length: CRAFT_OPEN_KEEP + 1 }, (_, i) => ({ ...INPUT, finish: i }));
    for (const b of builds) await host.craft(b);
    expect(m.open.size).toBe(CRAFT_OPEN_KEEP);
    await host.craft(builds.at(-1)!);              // свежий — помним
    await host.craft(builds[0]!);                  // старейший — вытеснен, ключ новый
    const nonces = sent.map((c) => craftCmd(c).nonce);
    expect(nonces[CRAFT_OPEN_KEEP + 1]).toBe(nonces[CRAFT_OPEN_KEEP]);
    expect(nonces[CRAFT_OPEN_KEEP + 2]).not.toBe(nonces[0]);
    expect(CRAFT_OPEN_KEEP, 'сервер помнит больше ключей, чем клиент держит открытыми').toBeLessThan(CRAFT_NONCES_KEEP);
  });

  it('успех повтором ключа, а вещи уже нет в сумке — «скована раньше», без вещи', async () => {
    const { link } = fakeLink(() => ok({ uid: 'sold-long-ago' }));
    const r = await gameCraftHost(link, memo()).craft(INPUT);
    expect(r.ok).toBe(true);
    expect(r.item).toBeUndefined();
    expect(r.reason).toMatch(/раньше/);
  });

  it('без связи — не шлёт ничего и говорит почему', async () => {
    const { link, sent } = fakeLink(() => ok());
    link.net.connected = false;
    const r = await gameCraftHost(link, memo()).craft(INPUT);
    expect(r).toMatchObject({ ok: false, reason: 'Нет связи с сервером' });
    expect(sent).toHaveLength(0);
  });

  it('зачарование: команда forgeEnchant; только magic/rare — иначе без отправки', async () => {
    const save = heroSave();
    const it0 = { ...save.equipment.weapon!, uid: 'w-1', pos: { x: 0, y: 0 } };
    save.inventory.push(it0);
    const { link, sent } = fakeLink(() => {
      save.inventory[0] = { ...it0, rarity: 'rare', name: 'Зачарованный' };   // сейв приходит РАНЬШЕ ответа (D3)
      return ok({ cmd: 'forgeEnchant', uid: 'w-1' });
    }, save);
    const host = gameCraftHost(link, memo());
    const bad = await host.enchant(it0, 'unique' as never);
    expect(bad.ok).toBe(false);
    expect(sent).toHaveLength(0);
    const r = await host.enchant(it0, 'rare');
    expect(sent).toEqual([{ cmd: 'forgeEnchant', uid: 'w-1', rarity: 'rare' }]);
    expect(r).toMatchObject({ ok: true, item: { name: 'Зачарованный' } });
  });

  it('надеть — обычной командой equip; отказ сервера доходит до окна', async () => {
    const { link, sent } = fakeLink(() => ok({ cmd: 'equip', ok: false, reason: 'Недостаточно атрибутов' }));
    const r = await gameCraftHost(link, memo()).equip!({ uid: 'w-2' } as never);
    expect(sent).toEqual([{ cmd: 'equip', uid: 'w-2' }]);
    expect(r).toMatchObject({ ok: false, reason: 'Недостаточно атрибутов' });
  });

  it('кошелёк = сумка + сундук; журнал — из кадра сундука; вещь находится и надетой', () => {
    const save = heroSave();
    save.inventory.push({ ...materialItem(reg.get('craft-materials').find((m) => m.id === 'iron-1')!, 4, 'mat-1'), pos: { x: 0, y: 0 } });
    const { link } = fakeLink(() => null, save, { ...emptyStash(reg), materials: { 'iron-1': 3, 'wood-2': 1 }, forgeJournal: fullJournal(reg) });
    const host = gameCraftHost(link, memo());
    expect(host.wallet()['iron-1']).toBe(7);
    expect(host.wallet()['wood-2']).toBe(1);
    expect(host.journal()).toEqual(fullJournal(reg));
    expect(findOwned(save, save.equipment.weapon!.uid)).toMatchObject({ inBag: false });
    expect(host.find!('nope')).toBeNull();
  });
});

describe('⭐ сквозной прогон с настоящим ядром сервера (craftAction)', () => {
  /**
   * «Сервер» — то же ядро, что в `room.ts`: заявка с ключом, повтор ключа отвечает прежней вещью.
   * `lose` — сколько следующих ответов потерять ПОСЛЕ того, как ковка уже прошла (обрыв связи).
   */
  function server() {
    const save = heroSave(50_000);
    const stash: AccountStash = { ...emptyStash(reg), materials: fullWallet(), forgeJournal: fullJournal(reg) };
    let seed = 1, lose = 0;
    const answer: Answer = (cmd) => {
      if (cmd.cmd !== 'craft') return ok({ ok: false, reason: 'не то' });
      const r = craftAction(reg, save, stash, cmd.nonce, cmd.input, createRng(seed++));
      if (lose > 0) { lose--; return null; }
      return ok({ ok: r.ok, reason: r.reason, uid: r.uid });
    };
    return { save, stash, answer, loseNext: (n = 1) => { lose = n; } };
  }
  const crafted = (s: SaveState): number => s.inventory.filter((i) => i.parts).length;

  it('⭐ ответ потерян после ковки → повтор → ОДНА вещь и ОДНО списание', async () => {
    const srv = server();
    const { link } = fakeLink(srv.answer, srv.save, srv.stash);
    link.stash!.materials = srv.stash.materials!;              // кошелёк — тот же объект, что у «сервера»
    const host = gameCraftHost(link, memo());
    const gold0 = srv.save.gold;

    srv.loseNext(2);
    expect((await host.craft(INPUT)).unknown).toBe(true);
    expect((await host.craft(INPUT)).unknown).toBe(true);
    const spent = gold0 - srv.save.gold;
    expect(crafted(srv.save)).toBe(1);
    expect(spent).toBeGreaterThan(0);

    const r = await host.craft(INPUT);
    expect(r.ok).toBe(true);
    expect(r.item?.uid).toBe(srv.save.inventory.find((i) => i.parts)!.uid);
    expect(crafted(srv.save)).toBe(1);
    expect(gold0 - srv.save.gold).toBe(spent);

    // Подтверждённый успех → ключ сгорел: следующая ковка той же сборки — вторая вещь за вторую цену.
    const r2 = await host.craft(INPUT);
    expect(r2.ok).toBe(true);
    expect(crafted(srv.save)).toBe(2);
    expect(gold0 - srv.save.gold).toBe(spent * 2);
  });

  it('⭐ R2-33: ответ A потерян → сковал B → вернулся к A: A одна, списание за неё одно', async () => {
    const srv = server();
    const { link } = fakeLink(srv.answer, srv.save, srv.stash);
    link.stash!.materials = srv.stash.materials!;
    const host = gameCraftHost(link, memo());
    const gold0 = srv.save.gold;

    srv.loseNext(1);
    expect((await host.craft(INPUT)).unknown).toBe(true);
    const spentA = gold0 - srv.save.gold;
    expect((await host.craft(OTHER)).ok).toBe(true);
    const spentAB = gold0 - srv.save.gold;
    expect(crafted(srv.save)).toBe(2);

    const again = await host.craft(INPUT);
    expect(again.ok).toBe(true);
    expect(crafted(srv.save), 'было: вторая A').toBe(2);
    expect(gold0 - srv.save.gold, 'было: второе списание за A').toBe(spentAB);
    expect(spentA).toBeGreaterThan(0);
  });
});

describe('⚠ R3-11: эскиз — командой forgeSketch', () => {
  it('команда проходит строгую схему сервера; успех, отказ и тишина — как у прочих команд кузницы', async () => {
    const replies: (CmdReply | null)[] = [
      ok({ cmd: 'forgeSketch', unlocked: ['Деталь «Широкий»'] }), ok({ cmd: 'forgeSketch', ok: false, reason: 'Эскизов нет' }), null,
    ];
    const { link, sent } = fakeLink(() => replies.shift() ?? null);
    const host = gameCraftHost(link, memo());
    expect(await host.sketch!('blade-a')).toEqual({ ok: true, reason: 'Деталь «Широкий»' });
    expect(await host.sketch!('blade-a')).toEqual({ ok: false, reason: 'Эскизов нет' });
    const lost = await host.sketch!('blade-a');
    expect(lost).toMatchObject({ ok: false, unknown: true });
    expect(sent).toEqual([1, 2, 3].map(() => ({ cmd: 'forgeSketch', variantId: 'blade-a' })));
    for (const c of sent) expect(parseTownCommand(c).ok, JSON.stringify(c)).toBe(true);
  });

  it('пока другая команда кузницы в полёте, эскиз не уходит', async () => {
    let release!: (r: CmdReply | null) => void;
    const { link, sent } = fakeLink(() => new Promise((res) => { release = res; }));
    const m = memo();
    const first = gameCraftHost(link, m).craft(INPUT) as Promise<CraftReply>;
    expect((await gameCraftHost(link, m).sketch!('blade-a')).ok).toBe(false);
    expect(sent).toHaveLength(1);
    release(ok({ uid: 'nope' }));
    await first;
  });
});

describe('⭐ R5-15: цена окна — в команду', () => {
  it('ковка и зачарование несут `maxGold`, который им дало окно; команда проходит строгую схему; без цены — без поля', async () => {
    const { link, sent } = fakeLink(() => ok({ uid: 'nope' }));
    const host = gameCraftHost(link, memo());
    await host.craft(INPUT, 660, { 'iron-2': 24, 'hide-2': 12 });
    await host.enchant({ uid: 'x' } as never, 'rare', 1234);
    await host.craft(OTHER);
    expect(sent.map((c) => ('maxGold' in c ? c.maxGold : 'нет')), 'было: ни одна не несла цены').toEqual([660, 1234, 'нет']);
    // R8-14: и сырьё окна — у ковки; нет его — нет поля.
    expect(sent.map((c) => ('maxMaterials' in c ? c.maxMaterials : 'нет'))).toEqual([{ 'iron-2': 24, 'hide-2': 12 }, 'нет', 'нет']);
    for (const c of sent) expect(parseTownCommand(c).ok, JSON.stringify(c)).toBe(true);
  });
});
