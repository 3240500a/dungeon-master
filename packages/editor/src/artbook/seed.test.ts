import { describe, it, expect } from 'vitest';
import { defaultConfigData } from '@dm/shared';
import { ROW_KEYS, getAt } from './model.js';
import { hasRoster, loadRoster, loadRosterIndex, loadSeed, rosterQueue, type ArtbookSeed, type RosterV2 } from './seed.js';

/**
 * ⭐ 16.10 (Артбук): сторож СИДА. Путь правки держится за ключ строки (`id` / `subtype` / `code`) — значит ключи в каждой
 * таблице черновика обязаны быть уникальными, иначе правка ляжет не на ту строку. Плюс сид согласован с конфигом: классы —
 * ровно классы игры, биомы заметок — существующие биомы.
 *
 * ⭐ 17.10: шесть подтипов (Египет и Междуречье — два, решение 16.10), выбор подтипа при спуске вместо слоёв по этажам,
 * решения владельца у вопросов; ростеры по ярусам (v2) — форма 3 яруса × (3 ближника + 2 стрелка), 3 босса, 4–6 особых,
 * ключ у КАЖДОЙ строки, родной статус — самый частый.
 */
const load = (): Promise<ArtbookSeed> => loadSeed();
/** Порядок документа — снизу вверх по слоям Некрополя. */
const IDS = ['mesopotamia', 'egypt', 'greece', 'rome', 'vikings', 'medieval'];
/** Номер в порядке владельца: Греция 1, Рим 2, викинги 3, Европа 4, Двор Тростника 5, Дом Праха 6. */
const OWNER_NO: Record<string, number> = { greece: 1, rome: 2, vikings: 3, medieval: 4, egypt: 5, mesopotamia: 6 };

/** Все массивы объектов в дереве: путь → массив. */
function arraysOf(x: unknown, path = '', out: [string, unknown[]][] = []): [string, unknown[]][] {
  if (Array.isArray(x)) {
    if (x.some((r) => r && typeof r === 'object' && !Array.isArray(r))) out.push([path, x]);
    x.forEach((r, i) => arraysOf(r, `${path}/${i}`, out));
  } else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) arraysOf(v, path ? `${path}/${k}` : k, out);
  return out;
}

/** Ключи строк уникальны и не числа; `strict` — ключ есть у каждой строки-объекта. */
function expectRowKeys(root: unknown, strict: boolean): void {
  for (const [path, arr] of arraysOf(root)) {
    const rows = arr.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r));
    const k = ROW_KEYS.find((key) => rows.some((r) => typeof r[key] === 'string'));
    if (!k) { if (strict) expect.fail(`${path}: у строк нет ключа`); continue; }
    const keys = rows.map((r) => r[k]);
    if (strict) expect(keys.every((v) => typeof v === 'string'), `${path}: не у всех строк есть ${k}`).toBe(true);
    const str = keys.filter((v): v is string => typeof v === 'string');
    expect(new Set(str).size, `${path}: повтор ${k}`).toBe(str.length);
    expect(str.some((v) => /^\d+$/.test(v)), `${path}: ключ-число спутается с индексом`).toBe(false);
  }
}

describe('artbook: сид', () => {
  it('черновик крипты: шесть подтипов по порядку документа, архетипы, матрица и таблицы — только на них', async () => {
    const { crypt } = await load();
    const ids = crypt.subtypes.map((s) => s.id);
    expect(ids).toEqual(IDS);
    for (const s of crypt.subtypes) expect(s.ownerNo, s.id).toBe(OWNER_NO[s.id]);
    for (const a of crypt.archetypes) for (const s of a.subtypes) expect(ids, a.id).toContain(s);
    expect(crypt.matrix.columns.map((c) => c.id)).toEqual(ids);
    // таблицы по подтипам — ровно по строке на подтип, в порядке документа
    for (const rows of [crypt.decayLadder.rows, crypt.statuses.rows, crypt.signatures.rows, crypt.readability.keys]) expect(rows.map((r) => r.subtype)).toEqual(ids);
    expect(crypt.intro.ownerOrder.owner.map((o) => o.id).sort()).toEqual([...ids].sort());
    for (const t of crypt.packs.templates) for (const s of Object.keys(t.perSubtype)) expect(ids, t.id).toContain(s);
    for (const r of crypt.matrix.common) expect(Object.keys(r.cells)).toEqual(ids);
    expect(Object.keys(crypt.matrix.uniqueBySubtype)).toEqual(ids);
    for (const e of crypt.eras) for (const s of e.subtypes) expect(ids, e.id).toContain(s);
    // общие архетипы архива — у всех шести, уникальные — у одного; слитого подтипа и его em_* больше нет
    for (const a of crypt.archetypes) {
      if (a.kind === 'common') expect(Object.keys(a.perSubtype), a.id).toEqual(ids);
      else expect(a.subtypes.length, a.id).toBe(1);
      expect(Object.keys(a.waveBySubtype).sort(), a.id).toEqual([...a.subtypes].sort());
      expect(a.id, 'em_* → eg_* / mes_*').not.toMatch(/^em_/);
    }
    expect(JSON.stringify(crypt)).not.toContain('"egypt_mesopotamia"');
    // у новых подтипов нет «домов» и «что слито» — есть «что разделено»
    for (const id of ['egypt', 'mesopotamia']) {
      const s = crypt.subtypes.find((x) => x.id === id)!;
      expect(s.houses, id).toBeUndefined();
      expect(s.mergeNotes, id).toBeUndefined();
      expect(s.splitNotes?.length, id).toBeGreaterThan(0);
    }
  });

  it('⭐ выбор подтипа при спуске вместо слоёв по этажам; у каждого вопроса — решение владельца', async () => {
    const { crypt } = await load();
    expect('layers' in crypt, 'слои по этажам сняты (решение 16.10)').toBe(false);
    expect(crypt.selection.rules.map((r) => r.id)).toEqual(['roll', 'term', 'seal', 'bosses', 'mix', 'ready']);
    expect(crypt.selection.seal.items.length).toBeGreaterThan(0);
    expect(crypt.questions.map((q) => q.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const q of crypt.questions) expect(q.decision.length, `вопрос ${q.n}`).toBeGreaterThan(20);
    expect(crypt.decisions.length).toBeGreaterThan(10);
    expect(crypt.intro.loreNote).toMatch(/лор, а не раскладка/);
    expect(crypt.statuses.notes.map((n) => n.id)).toEqual(['setting', 'mostCommon']);
    expect(crypt.engine.marks.map((m) => m.mark)).toEqual(['есть', 'легко', 'на будущее']);
    expect(crypt.engine.beforeDemoTitle).toMatch(/^Если дойдём до кода/);
  });

  it('⭐ ключи строк уникальны в каждой таблице сида — путь правки не перепутает строки', async () => {
    expectRowKeys(await load(), false);
  });

  it('пути страниц находят поля черновика', async () => {
    const seed = await load();
    for (const p of [
      'crypt/subtypes/greece/lore', 'crypt/decayLadder/rows/rome/body', 'crypt/selection/rules/seal/how', 'crypt/selection/seal/items/grade/text',
      'crypt/engine/codes/К1/name', 'crypt/engine/existingMap/zombie/to', 'crypt/packs/templates/herd/perSubtype/vikings',
      'crypt/packs/templates/herd/perSubtype/egypt', 'crypt/eras/archaic/note', 'crypt/intro/purpose/0', 'crypt/readability/keys/rome/head',
      'crypt/readability/keys/mesopotamia/head', 'crypt/questions/0/rec', 'crypt/questions/1/decision', 'crypt/decisions/subtypeRoll/text',
      'crypt/statuses/notes/mostCommon/items/0', 'crypt/engine/composite/units/turtle/text', 'crypt/subtypes/egypt/splitNotes/0',
      'crypt/archetypes/eg_khopesh_veteran/perSubtype/egypt/twist', 'crypt/archetypes/herald/perSubtype/mesopotamia/name',
      'classes/classes/mage/lore', 'locations/biomes/crypt/artNotes',
    ]) expect(typeof getAt(seed, p), p).toBe('string');
  });

  it('классы сида = классы конфига; биомы заметок — из конфига', async () => {
    const { classes, locations } = await load();
    const cfgClasses = (defaultConfigData.classes as { id: string }[]).map((c) => c.id).sort();
    expect(classes.classes.map((c) => c.id).sort()).toEqual(cfgClasses);
    const biomes = (defaultConfigData.biomes as { id: string }[]).map((b) => b.id);
    for (const b of locations.biomes) expect(biomes).toContain(b.id);
  });
});

describe('artbook: ростеры по ярусам (v2)', () => {
  const all = async (): Promise<RosterV2[]> => Promise.all(IDS.map((id) => loadRoster(id)));

  it('по ростеру на подтип; форма: 3 яруса × (3 ближника + 2 стрелка), боссы 5 / 14 / 19, 4–6 особых', async () => {
    for (const r of await all()) {
      expect(hasRoster(r.id), r.id).toBe(true);
      expect(r.tiers.map((t) => t.id), r.id).toEqual(['light', 'medium', 'heavy']);
      expect(r.tiers.map((t) => t.powerTier), r.id).toEqual(['weak', 'medium', 'strong']);
      for (const t of r.tiers) {
        expect(t.cards.filter((c) => c.combat === 'melee').length, `${r.id}/${t.id}: ближники`).toBe(3);
        expect(t.cards.filter((c) => c.combat === 'ranged').length, `${r.id}/${t.id}: стрелки`).toBe(2);
        expect(t.cards.length, `${r.id}/${t.id}`).toBe(5);
      }
      expect(r.bosses.map((b) => [b.floor, b.tier]), r.id).toEqual([[5, 'light'], [14, 'medium'], [19, 'heavy']]);
      expect(r.specials.length, r.id).toBeGreaterThanOrEqual(4);
      expect(r.specials.length, r.id).toBeLessThanOrEqual(6);
      const ids = [...r.tiers.flatMap((t) => t.cards), ...r.specials, ...r.bosses].map((c) => c.id);
      expect(new Set(ids).size, `${r.id}: id карточек уникальны`).toBe(ids.length);
      for (const p of r.packs) for (const m of [...p.members, ...p.optional]) expect(ids, `${r.id}/${p.id}: ${m.card}`).toContain(m.id);
    }
    await expect(loadRoster('egypt_mesopotamia')).rejects.toThrow();
  });

  it('⭐ ключ у КАЖДОЙ строки каждой таблицы ростера — уникальный и не число', async () => {
    for (const r of await all()) expectRowKeys(r, true);
    expectRowKeys(await loadRosterIndex(), true);
  });

  it('⭐ главный статус подтипа — самый частый по карточкам; он же главный в таблице статусов черновика', async () => {
    const { crypt } = await load();
    for (const r of await all()) {
      const native = r.rules.statuses.native;
      const counts = Object.entries(r.statusCount.cards).sort((a, b) => b[1] - a[1]);
      expect(counts[0]![0], r.id).toBe(native.status);
      expect(counts[0]![1], `${r.id}: «самый частый», не делит место`).toBeGreaterThan(counts[1]?.[1] ?? 0);
      expect([native.mult, r.rules.statuses.second.mult, r.rules.statuses.foreign.mult], r.id).toEqual([1.25, 1, 0.8]);
      expect(crypt.statuses.rows.find((x) => x.subtype === r.id)!.main.startsWith(native.status), r.id).toBe(true);
    }
  });

  it('индекс: подтипы по порядку черновика, счёты сходятся, общие таблицы, очереди — 143 карточки в работе', async () => {
    const [idx, rosters] = await Promise.all([loadRosterIndex(), all()]);
    expect(idx.order).toEqual(IDS);
    expect(idx.subtypes.map((s) => s.id)).toEqual(IDS);
    for (const r of rosters) {
      const s = idx.subtypes.find((x) => x.id === r.id)!;
      expect(s.counts.cards, r.id).toBe(15);
      expect(s.counts.specials, r.id).toBe(r.specials.length);
      expect(s.native, r.id).toEqual(r.rules.statuses.native);
      expect(r.transition.bands.map((b) => [b.band, b.light, b.medium, b.heavy]), r.id).toEqual(idx.transition.bands.map((b) => [b.id, b.light, b.medium, b.heavy]));
    }
    for (const b of idx.transition.bands) expect(b.light + b.medium + b.heavy, b.id).toBe(100);
    expect(idx.tierResistMult.heavy).toEqual({ slashing: 0.75, piercing: 0.85, crushing: 1.25, lightning: 1.2 });
    const rows = rosters.flatMap((r) => rosterQueue(r, idx.roster.queues));
    const inWork = rows.filter((x) => x.queue !== 'bank');
    expect(inWork.length).toBe(143);
    for (const r of rosters) {
      const q = rosterQueue(r, idx.roster.queues);
      expect(q.filter((x) => x.queue === 'q1').length, r.id).toBe(10);
      expect(q.filter((x) => x.queue === 'q2').map((x) => x.kind), r.id).toEqual(['card', 'card', 'card', 'card', 'card', 'boss']);
    }
  });
});
