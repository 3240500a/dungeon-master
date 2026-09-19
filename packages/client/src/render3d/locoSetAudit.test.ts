import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { auditChar, auditLocoSet, staleNames, severityOf, REQUIRED_NAMES, REBAKEABLE, CURRENT_BAKE_REV } from './locoSetAudit.js';
import { LOCO_BAKE_RUN_SPD, LOCO_BAKE_WALK_SPD, gaitBakeTag, findLocoClip, BASE_LOCO_WEAPON } from './locoBlend.js';
import { SWING_KEY, TURN_NAMES } from './turnInPlace.js';
import { LOCO_CARDINAL_REV } from './poseRuntime.js';
import type { Clip } from './clipModel.js';

/**
 * ПОКРЫТИЕ НАБОРА — сторожа.
 *
 * Панель, которая врёт про состояние контента, хуже отсутствующей: по ней принимают решение «печь или не печь».
 * Поэтому каждый дефект проверяется на входе, где ответ известен заранее, и отдельно — что ИСПРАВНЫЙ набор не даёт
 * ни одного дефекта (иначе панель превращается в шум, который перестают читать).
 */
const good = (name: string, charId = 'warrior'): Clip => {
  const gait = name.startsWith('run_') || name.startsWith('walk_');
  const pose = gait ? { [SWING_KEY]: [0, 1, 0] as [number, number, number] } : {};
  return {
    name, character: charId, weapon: 'none', loop: true, keys: [{ t: 0, pose }, { t: 0.5, pose }],
    ...(gait ? {
      bakeSpeed: name.startsWith('run_') ? LOCO_BAKE_RUN_SPD : LOCO_BAKE_WALK_SPD,
      bakeRev: CURRENT_BAKE_REV, upperPure: true, bakeId: 777,
      swingRef: { RightUpperArm: [0, 0, 0] as [number, number, number] },
    } : {}),
  } as unknown as Clip;
};
const fullSet = (charId = 'warrior'): Clip[] => REQUIRED_NAMES.map((n) => good(n, charId));
const isGaitName = (n: string): boolean => n.startsWith('run_') || n.startsWith('walk_');
const kinds = (c: ReturnType<typeof auditChar>): string[] => [...new Set(c.defects.map((d) => d.kind))].sort();

describe('покрытие набора локомоции', () => {
  it('⭐ ИСПРАВНЫЙ НАБОР НЕ ДАЁТ НИ ОДНОГО ДЕФЕКТА — иначе панель превращается в шум', () => {
    const cov = auditChar(fullSet(), 'warrior');
    expect(cov.defects, JSON.stringify(cov.defects.slice(0, 3))).toEqual([]);
    expect(cov.own).toBe(REQUIRED_NAMES.length);
    expect(cov.borrowed).toBe(0);
    expect(severityOf(cov)).toBe('ok');
    expect(staleNames(cov)).toEqual([]);
  });

  it('⭐ НАБОР СПРАШИВАЕТСЯ РОВНО ТОТ, ЧТО СПРАШИВАЕТ ДВИЖОК: 8 ходовых + стойка + повороты', () => {
    expect(REQUIRED_NAMES).toContain('run_fwd');
    expect(REQUIRED_NAMES).toContain('walk_strafe_L');
    expect(REQUIRED_NAMES).toContain('idle');
    for (const t of TURN_NAMES) expect(REQUIRED_NAMES, `поворот ${t}`).toContain(t);
    expect(REQUIRED_NAMES.length).toBe(8 + 1 + TURN_NAMES.length);
    expect(new Set(REQUIRED_NAMES).size, 'дублей нет').toBe(REQUIRED_NAMES.length);
  });

  it('⭐⭐ НЕТ КЛИПА И НЕТ ДОНОРА — блокер: кукла останется на планировщике', () => {
    const set = fullSet().filter((c) => c.name !== 'run_strafe_L');
    const cov = auditChar(set, 'warrior');
    expect(cov.defects.map((d) => [d.kind, d.name])).toEqual([['missing', 'run_strafe_L']]);
    expect(severityOf(cov)).toBe('block');
    expect(staleNames(cov), 'перезапеканием отсутствие клипа не лечится').toEqual([]);
  });

  it('⭐ МОНСТР БЕЗ СВОИХ КЛИПОВ: всё донорское, и это видно ЯВНО, а не молча', () => {
    const cov = auditChar(fullSet('warrior'), 'mon_undead', 'warrior');
    expect(cov.own).toBe(0);
    expect(cov.borrowed).toBe(REQUIRED_NAMES.length);
    expect(kinds(cov)).toEqual(['fallback']);
    expect(cov.defects[0]!.from).toBe('warrior');
    expect(severityOf(cov), 'чужой набор — не поломка, но и не «всё хорошо»').toBe('info');
  });

  it('свой клип бьёт донорский: где есть свой — «fallback» не пишется', () => {
    const set = [...fullSet('warrior'), good('run_fwd', 'mon_undead')];
    const cov = auditChar(set, 'mon_undead', 'warrior');
    expect(cov.own).toBe(1);
    expect(cov.defects.find((d) => d.name === 'run_fwd')).toBeUndefined();
  });

  it('⭐ ПРОТУХАНИЕ: чужая скорость, старая ревизия, впечённая стойка, нет канала опоры и нейтрали', () => {
    const bad = (patch: Partial<Clip>): ReturnType<typeof auditChar> =>
      auditChar(fullSet().map((c) => (c.name === 'run_fwd' ? { ...c, ...patch } as Clip : c)), 'warrior');
    expect(kinds(bad({ bakeSpeed: 102 }))).toEqual(['stale_speed']);
    expect(kinds(bad({ bakeRev: 1 }))).toEqual(['stale_rev']);
    expect(kinds(bad({ upperPure: undefined }))).toEqual(['dirty_upper']);
    expect(kinds(bad({ keys: [{ t: 0, pose: {} }] as Clip['keys'] }))).toEqual(['no_swing']);
    expect(kinds(bad({ swingRef: undefined }))).toEqual(['no_ref']);
    // ⚠ Кардинальная ревизия и текущая — РАЗНЫЕ: клип ревизии 2 свежий для секторов, но у него нет новых пометок.
    expect(kinds(bad({ bakeRev: LOCO_CARDINAL_REV, upperPure: undefined, swingRef: undefined, keys: [{ t: 0, pose: {} }] as Clip['keys'] })))
      .toEqual(['dirty_upper', 'no_ref', 'no_swing']);
  });

  it('⭐ РАЗНЫЕ ПРОГОНЫ — отдельный дефект: по самим позам этого не видно', () => {
    const cov = auditChar(fullSet().map((c) => (c.name === 'run_back' ? { ...c, bakeId: 999 } as Clip : c)), 'warrior');
    expect(kinds(cov)).toEqual(['split_bake']);
    expect(severityOf(cov)).toBe('warn');
  });

  it('«перезапечь протухшее» берёт ИМЕНА клипов, а не дефекты: у одного клипа их может быть несколько', () => {
    const cov = auditChar(fullSet().map((c) => (c.name === 'run_fwd'
      ? { ...c, upperPure: undefined, swingRef: undefined, keys: [{ t: 0, pose: {} }] as Clip['keys'] } as Clip : c)), 'warrior');
    expect(cov.defects.length, 'три дефекта на одном клипе').toBe(3);
    expect(staleNames(cov), 'а перезапечь надо один раз').toEqual(['run_fwd']);
    for (const d of cov.defects) expect(REBAKEABLE.has(d.kind), d.kind).toBe(true);
  });

  it('стойка и повороты не проверяются на поля клипов ХОДА (их там нет по построению)', () => {
    const cov = auditChar(fullSet(), 'warrior');
    expect(cov.defects.filter((d) => d.name === 'idle' || d.name.startsWith('turn_'))).toEqual([]);
  });

  it('аудит по роcтеру: донор сам себе донором не считается', () => {
    const all = auditLocoSet(fullSet('warrior'), ['warrior', 'mon_undead'], 'warrior');
    expect(all.map((c) => c.charId)).toEqual(['warrior', 'mon_undead']);
    expect(all[0]!.defects, 'у самого донора «играет чужой» быть не может').toEqual([]);
    expect(all[1]!.borrowed).toBe(REQUIRED_NAMES.length);
  });
});

/**
 * ⚠⚠ ТЕГ ОРУЖИЯ У НАБОРА ХОДА.
 *
 * Запекатель гасит авторскую стойку принудительно — руки в клипе походки безоружные ВСЕГДА. А тег до 19.09 брался
 * из текущего выбора редактора. Ключ дедупа библиотеки — тройка (имя, персонаж, ОРУЖИЕ), поэтому второе запекание
 * при другом выборе кладёт ВТОРОЙ набор рядом, а не заменяет первый: `findLocoClip` дальше выдаёт каждому оружию
 * свой, и автор видит «перезапёк, а половина настроек не доехала». Заметить нечем — имена одинаковые.
 */
describe('тег оружия у набора хода', () => {
  const tagged = (name: string, w: string): Clip => ({ ...good(name), weapon: w });

  it('⚠⚠ НАБОР, ПОМЕЧЕННЫЙ ОРУЖИЕМ, — ЭТО ДЕФЕКТ, А НЕ НОРМА', () => {
    const cov = auditChar(fullSet().map((c) => (c.name === 'run_fwd' ? tagged('run_fwd', 'sword') : c)), 'warrior');
    const d = cov.defects.filter((x) => x.kind === 'weapon_tag');
    expect(d.length, '⚠ тег оружия у безоружного набора не показан — автор его не увидит').toBe(1);
    expect(d[0]!.name).toBe('run_fwd');
    expect(d[0]!.note).toContain('sword');
    expect(severityOf(cov), 'это предупреждение, а не мелочь: набор молча разъедется по оружиям').toBe('warn');
  });

  it('⭐ РАЗДВОЕНИЕ НАБОРА ПО ОРУЖИЮ названо своими словами', () => {
    // Ровно то, что получается после двух запеканий при разном выборе оружия.
    const cov = auditChar([...fullSet(), tagged('run_fwd', 'sword')], 'warrior');
    const d = cov.defects.find((x) => x.kind === 'weapon_tag');
    expect(d?.note, '⚠ «раздвоился» — единственная формулировка, по которой понятно, что играют РАЗНЫЕ клипы').toContain('раздвоился');
  });

  it('пооружный набор виден и тогда, когда БАЗОВОГО нет вовсе (клип всё равно найдётся — через «любой»)', () => {
    const cov = auditChar(fullSet().map((c) => (isGaitName(c.name) ? { ...c, weapon: 'greatsword' } : c)), 'warrior');
    expect(cov.defects.filter((d) => d.kind === 'weapon_tag').length).toBe(8);
    expect(cov.defects.filter((d) => d.kind === 'missing'), 'клипы находятся — жалоба именно на тег').toEqual([]);
  });

  /**
   * ⚠⚠ ЭТОТ ТЕСТ ЗАКРЕПЛЯЛ ОШИБКУ, И ПОЙМАЛ ЕЁ СОСТЯЗАТЕЛЬНЫЙ ОБЗОР ДИФФА, А НЕ ТЕСТЫ.
   *
   * Он утверждал «стойку И ПОВОРОТЫ тег не касается: у них он осмысленный». Для СТОЙКИ это верно
   * (`idle_sword` — стойка МЕЧА). Для ПОВОРОТОВ — нет: их пишет ТА ЖЕ кнопка тем же тегом, а
   * `bakeTurnToClip` идёт через тот же `procedural()` с `setLayerBakeOverride(true)` — руки в клипе
   * поворота ровно так же безоружные.
   *
   * Цена пропуска: у автора уже лежат повороты со СТАРЫМ тегом. Перезапекание теперь пишет `none`,
   * то есть кладёт НОВЫЙ клип РЯДОМ (ключ дедупа — тройка с оружием), а под тем самым оружием
   * `findLocoClip` продолжает отдавать СТАРЫЙ — ровно жалоба «перезапёк, а не доехало», ради которой
   * проверка и заводилась. Панель при этом светила зелёное `ok`.
   */
  it('⚠⚠ ТЕГ НА КЛИПЕ ПОВОРОТА — ТОЖЕ ДЕФЕКТ (его пишет та же кнопка тем же тегом)', () => {
    const turn = TURN_NAMES[0]!;
    const cov = auditChar(fullSet().map((c) => (c.name === turn ? { ...c, weapon: 'sword' } : c)), 'warrior');
    expect(cov.defects.filter((d) => d.kind === 'weapon_tag').map((d) => d.name),
      '⚠ поворот со старым тегом невидим: перезапечённый ляжет рядом, а играть будет старый').toEqual([turn]);
    expect(severityOf(cov)).toBe('warn');
  });

  it('⚙ а у СТОЙКИ тег осмысленный (`idle_sword` — стойка МЕЧА), и дефектом не считается', () => {
    const cov = auditChar(fullSet().map((c) => (c.name === 'idle' ? { ...c, weapon: 'sword' } : c)), 'warrior');
    expect(cov.defects.filter((d) => d.kind === 'weapon_tag')).toEqual([]);
  });

  it('⚠ «КЛИПА НЕТ» БОЛЬШЕ НЕ ОБЕЩАЕТ ОТКАТА НА ПЛАНИРОВЩИКА', () => {
    // С Э13б планировщика у игровой куклы нет вовсе — персонаж СКОЛЬЗИТ в стойке. Обещание отката,
    // которого нет, хуже молчания: автор решит, что дыра не срочная.
    const cov = auditChar(fullSet().filter((c) => c.name !== 'run_fwd'), 'warrior');
    const d = cov.defects.find((x) => x.kind === 'missing');
    expect(d?.note).toContain('СКОЛЬЗИТЬ');
    expect(d?.note, '⚠ панель снова обещает планировщик').not.toContain('останется на планировщике');
  });

  it('исправный безоружный набор дефекта тега не даёт', () => {
    expect(auditChar(fullSet(), 'warrior').defects.filter((d) => d.kind === 'weapon_tag')).toEqual([]);
  });

  it('⚠⚠ БЕЗ ГАЛКИ ТЕГ = БАЗОВЫЙ, ЧЕМ БЫ НИ ПОЗИРОВАЛИ', () => {
    // Правило живёт в `locoBlend` рядом с поиском по тегу — и проверяется ПО-НАСТОЯЩЕМУ, а не чтением исходника.
    for (const w of ['sword', 'greatsword', 'bow', 'none', '']) {
      expect(gaitBakeTag(false, w), `позировали «${w}» — набор всё равно базовый`).toBe(BASE_LOCO_WEAPON);
    }
  });

  it('с галкой тег = выбранное оружие, но пустой выбор всё равно даёт базовый', () => {
    expect(gaitBakeTag(true, 'greatsword')).toBe('greatsword');
    expect(gaitBakeTag(true, '')).toBe(BASE_LOCO_WEAPON);
  });

  it('⭐⭐ БАЗОВЫЙ ТЕГ — ТОТ ЖЕ, ЧТО РАНТАЙМ СЧИТАЕТ БАЗОЙ (а не просто «находится»)', () => {
    // ⚠ Проверять «клип нашёлся» НЕДОСТАТОЧНО: у `findLocoClip` последняя ступень — «любой», и она находит что
    // угодно. Поэтому рядом кладётся ЧУЖОЙ набор, стоящий в массиве ПЕРВЫМ: если базовый тег разойдётся с тем,
    // что рантайм считает базой, победит чужой — молча и именно так, как это случается в живой библиотеке.
    const decoy = { ...good('run_fwd'), weapon: 'zzz_другое_оружие' };
    const base = { ...good('run_fwd'), weapon: gaitBakeTag(false, 'sword') };
    for (const w of ['axe', 'bow']) {
      expect(findLocoClip([decoy, base], 'run_fwd', 'warrior', w)?.weapon,
        `под «${w}» обязан играть БАЗОВЫЙ набор, а не первый попавшийся`).toBe(BASE_LOCO_WEAPON);
    }
    expect(findLocoClip([decoy, base], 'run_fwd', 'warrior', 'zzz_другое_оружие')?.weapon,
      'а точный пооружный набор по-прежнему бьёт базовый').toBe('zzz_другое_оружие');
  });

  it('⚠⚠ РЕДАКТОР ЗОВЁТ ИМЕННО ЭТО ПРАВИЛО, А НЕ СВОЮ КОПИЮ', () => {
    // Сам вызов — единственное, что осталось проверять по исходнику: модуль DOM-ный и в node не импортируется.
    const src = readFileSync(path.join(__dirname, 'pose-editor.ts'), 'utf8');
    const i = src.indexOf('const opts = { character: curCharId,');
    expect(i, '⚠ разбор настроек запекания сломался').toBeGreaterThan(0);
    expect(src.slice(i, i + 200).includes('weapon: bakeTag()'),
      '⚠ тег снова берётся из выбора панели: два запекания при разном оружии положат ДВА набора под одним именем')
      .toBe(true);
    expect(src.includes('const bakeTag = (): string => gaitBakeTag(bakePerWeapon, weapon);'),
      '⚠ редактор завёл СВОЮ копию правила — она разойдётся с поиском набора молча').toBe(true);
  });
});
