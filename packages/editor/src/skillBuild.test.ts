import { describe, it, expect, beforeAll } from 'vitest';
import { ConfigRegistry, newCharacterSave, socketInsert, resolveActive, insertById, type SaveState } from '@dm/shared';
import { previewBuild, previewSave, insertReachable, ensureDonors } from './skillBuild.js';

/**
 * РЕДАКТОР СЧИТАЕТ ТО ЖЕ, ЧТО СЕРВЕР. Дизайнер балансирует по числам из предпросмотра, и если они
 * расходятся с игрой хоть на процент — вся настройка идёт мимо. Поэтому здесь не «функция вернула
 * объект», а сверка двух ПУТЕЙ: предпросмотр против сейва, собранного АВТОРИТЕТНЫМИ командами.
 */
let cfg: ConfigRegistry;
beforeAll(() => { cfg = new ConfigRegistry(); cfg.loadAll(); });

/** Носитель из постановки задачи — «удар щитом». */
const CARRIER = 'b-shield-a1';
const RANK = 12;                                   // при порогах 1/6/12 — три гнезда

/** Сейв игрока, собранный так, как это происходит в игре: ранги в дереве + команды socketInsert. */
function playerSave(ids: readonly string[]): SaveState {
  const s = newCharacterSave(cfg, 'warrior', 'Hero', 'c1');
  s.skills[CARRIER] = RANK;
  // Ранг в узлах-донорах — то же, что игрок сделал бы очками; сами вставки открывает уже дерево.
  for (const id of ids) {
    const donor = cfg.get('skill-tree').nodes.find((n) => n.effect.grantsInsert === id);
    if (donor) s.skills[donor.id] = 1;
  }
  ids.forEach((id, i) => socketInsert(cfg, s, CARRIER, i, id));
  return s;
}

describe('предпросмотр сборки = то, что посчитает сервер', () => {
  it('три вставки разных типов: способность, проки и состав совпадают', () => {
    const ids = ['ins-flame-edge', 'ins-cold-wave', 'ins-ward'];
    const server = resolveActive(cfg, playerSave(ids), CARRIER)!;
    const editor = previewBuild(cfg, CARRIER, RANK, ids)!.resolved;

    expect(server.applied.map((i) => i.id), 'сервер принял все три').toEqual(ids);
    expect(editor.applied.map((i) => i.id)).toEqual(server.applied.map((i) => i.id));
    expect(editor.active).toEqual(server.active);          // глубокое равенство: числа сходятся
    expect(editor.procs).toEqual(server.procs);
  });

  it('правило «одна вставка типа» в предпросмотре то же, что на сервере', () => {
    const ids = ['ins-flame-edge', 'ins-frost-edge'];       // обе типа damage
    const server = resolveActive(cfg, playerSave(ids), CARRIER)!;
    const editor = previewBuild(cfg, CARRIER, RANK, ids)!.resolved;
    expect(server.applied.length, 'вторая того же типа не встала').toBe(1);
    expect(editor.applied.map((i) => i.id)).toEqual(server.applied.map((i) => i.id));
    expect(editor.active).toEqual(server.active);
  });

  it('гнездо сверх ранга не считается — как и в игре', () => {
    const ids = ['ins-flame-edge', 'ins-cold-wave'];
    const s = newCharacterSave(cfg, 'warrior', 'Hero', 'c1');
    s.skills[CARRIER] = 1;                                   // ранг 1 → одно гнездо
    for (const id of ids) s.skills[cfg.get('skill-tree').nodes.find((n) => n.effect.grantsInsert === id)!.id] = 1;
    s.sockets = { [CARRIER]: [...ids] };                     // подложено МИМО команд — сервер всё равно учтёт одну
    const server = resolveActive(cfg, s, CARRIER)!;
    const editor = previewBuild(cfg, CARRIER, 1, ids)!.resolved;
    expect(server.applied.length).toBe(1);
    expect(editor.applied.map((i) => i.id)).toEqual(server.applied.map((i) => i.id));
  });

  it('голый носитель — ТОТ ЖЕ объект: предпросмотр не подменяет способность', () => {
    const pv = previewBuild(cfg, CARRIER, RANK, [])!;
    expect(pv.resolved.active).toBe(pv.base);
  });

  it('синтетический сейв открывает всех доноров — иначе предпросмотр молча пустовал бы', () => {
    const save = previewSave(cfg, CARRIER, RANK, []);
    for (const n of cfg.get('skill-tree').nodes) {
      if (n.effect.grantsInsert) expect(save.skills[n.id], n.id).toBeGreaterThan(0);
    }
  });
});

describe('предупреждение о недостижимой вставке', () => {
  it('вставка с донором достижима, выдуманная — нет', () => {
    const real = cfg.get('skill-inserts')[0]!.id;
    expect(insertById(cfg, real)).toBeDefined();
    expect(insertReachable(cfg, real)).toBe(true);
    expect(insertReachable(cfg, 'ins-которой-нет')).toBe(false);
  });
});

describe('авторинг: вставка без донора всё равно считается', () => {
  /**
   * Заводя новую вставку, дизайнер сперва настраивает ЧИСЛА и только потом вешает её на узел.
   * Если предпросмотр до этого показывает нули, настраивать нечего — а плашка «недостижима»
   * говорит о другой проблеме и никуда не девается.
   */
  it('ensureDonors открывает вставку, у которой донора нет', () => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    // Снимаем донора у настоящей вставки — ровно то состояние, в котором живёт новая.
    const donor = reg.get('skill-tree').nodes.find((n) => n.effect.grantsInsert === 'ins-flame-edge')!;
    donor.effect.grantsInsert = undefined;
    expect(insertReachable(reg, 'ins-flame-edge'), 'донора действительно нет').toBe(false);
    expect(previewBuild(reg, CARRIER, RANK, ['ins-flame-edge'])!.resolved.applied, 'без раздачи — пусто').toEqual([]);

    ensureDonors(reg);
    expect(previewBuild(reg, CARRIER, RANK, ['ins-flame-edge'])!.resolved.applied.map((i) => i.id))
      .toEqual(['ins-flame-edge']);
  });

  it('ensureDonors не трогает уже назначенных доноров', () => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    const before = reg.get('skill-tree').nodes.filter((n) => n.effect.grantsInsert).map((n) => `${n.id}=${n.effect.grantsInsert}`);
    ensureDonors(reg);
    const after = reg.get('skill-tree').nodes.filter((n) => n.effect.grantsInsert).map((n) => `${n.id}=${n.effect.grantsInsert}`);
    expect(after).toEqual(before);   // все вставки уже розданы — добавлять нечего
  });
});
