import {
  CRAFT_SLOT_LIST, MATERIAL_STEPS, anatomyOf, partById, partFits, weaponLookSig,
  type ConfigRegistry, type CraftParts, type WeaponLookHand,
} from '@dm/shared';

/**
 * ВИД ОРУЖИЯ В ЗАПРОСЕ МОДЕЛИ (`GET /api/craft-mesh.glb?look=…`, docs/CRAFT_WEAPONS.md §21.1 «Модель из деталей — GLB с сервера»).
 *
 * На проводе вид — ПОДПИСЬ руки (`weaponLookSig`: `база|удар:id:ступень|рукоять:…|обвязка:…|оголовье:…`, гнёзда в
 * порядке `CRAFT_SLOT_LIST`). Подпись без потерь кодирует `WeaponLookHand` и у одного вида ровно одна — значит, один
 * адрес на модель: кэш клиента (Unity кэширует GLB по адресу) и ETag сервера сходятся сами. Принимается только
 * КАНОНИЧЕСКАЯ запись: разобранное и подписанное заново обязано совпасть с присланным, иначе один вид получал бы
 * сколько угодно адресов (и записей кэша).
 *
 * Без `three` и построителей: модуль стоит на пути каждого запроса, построитель — только в потоке печи (`worker.ts`).
 */

/** Потолок длины id в виде — тот же, что у сервера, рассылающего вид (`LOOK_ID_MAX` в `shared/session/weapon3d.ts`). */
export const LOOK_ID_MAX = 64;
/** Потолок длины подписи: база и четыре детали по 64 знака плюс ступени и разделители — с запасом. */
export const LOOK_TEXT_MAX = LOOK_ID_MAX * 5 + 4 * 4 + 8;

/** id в подписи: тот же набор знаков, что у id конфига (`[a-z0-9-]`), с заглавными и `_` про запас; без `|` и `:`. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const STEP_RE = /^[1-9]$/;

export type LookParse = { ok: true; hand: WeaponLookHand; sig: string } | { ok: false; reason: string };

/** Разобрать подпись из строки запроса. Только форма — существование деталей судит `checkLook`. */
export function parseLook(raw: string | undefined): LookParse {
  if (raw === undefined) return { ok: false, reason: 'Вид оружия — одной строкой (look)' };
  if (!raw) return { ok: false, reason: 'Нет вида оружия (look)' };
  if (raw.length > LOOK_TEXT_MAX) return { ok: false, reason: 'Вид оружия слишком длинный' };
  const seg = raw.split('|');
  if (seg.length !== 1 + CRAFT_SLOT_LIST.length) return { ok: false, reason: 'Вид оружия: база и четыре детали' };
  const baseId = seg[0]!;
  if (!ID_RE.test(baseId)) return { ok: false, reason: 'Вид оружия: неверная база' };
  const parts = {} as CraftParts;
  for (let i = 0; i < CRAFT_SLOT_LIST.length; i++) {
    const s = seg[i + 1]!;
    const at = s.lastIndexOf(':');
    const id = s.slice(0, at), step = s.slice(at + 1);
    if (at <= 0 || !ID_RE.test(id) || !STEP_RE.test(step)) return { ok: false, reason: `Вид оружия: неверная деталь гнезда ${CRAFT_SLOT_LIST[i]}` };
    parts[CRAFT_SLOT_LIST[i]!] = { id, step: Number(step) };
  }
  const hand: WeaponLookHand = { baseId, parts };
  const sig = weaponLookSig(hand);
  if (sig !== raw) return { ok: false, reason: 'Вид оружия не в канонической записи' };
  return { ok: true, hand, sig };
}

export type LookCheck = { ok: true; weaponClass: string; hands: number } | { ok: false; reason: string };

/**
 * ⭐ ГОДЕН ЛИ ВИД — ровно то, что сервер сам рассылает пирам (`weaponLookOf`): база — оружие этого конфига, у класса есть анатомия,
 * каждая деталь существует, стоит в СВОЁМ гнезде и подходит классу и хвату базы, ступень — целая 1…5.
 *
 * ⚠ Это НЕ `resolveParts` ковки: тот судит НОВУЮ вещь и строже — выключенную деталь и ступень вне окна материалов
 * отказывает. А вещь, скованная или найденная раньше, носит свои детали и после того, как деталь выключили или окно сузили
 * (R6-10), сервер рассылает её вид как есть, и веб-клиент её рисует (`meshCtx` берёт деталь и мимо окна). Откажи здесь —
 * пир в Unity увидел бы процедурный меш там, где веб показывает скованное. Поэтому правило гнезда, класса и хвата — то же
 * (`partFits`), а включённость и окно не судятся.
 */
export function checkLook(reg: ConfigRegistry, hand: WeaponLookHand): LookCheck {
  const base = reg.get('items.base').find((b) => b.id === hand.baseId);
  if (!base || base.kind !== 'weapon') return { ok: false, reason: `Нет такого оружия: ${hand.baseId}` };
  const weaponClass = base.weaponClass;
  const hands = base.hands ?? 1;
  if (!anatomyOf(reg, weaponClass)) return { ok: false, reason: `Такого класса кузнец не знает: ${weaponClass}` };
  for (const slot of CRAFT_SLOT_LIST) {
    const pick = hand.parts[slot];
    const p = partById(reg, pick.id);
    if (!p) return { ok: false, reason: `Нет такой детали: ${pick.id}` };
    if (!partFits({ ...p, enabled: true }, weaponClass, slot, hands)) return { ok: false, reason: `«${p.name}» не для этого гнезда или оружия` };
    if (!Number.isInteger(pick.step) || pick.step < 1 || pick.step > MATERIAL_STEPS) return { ok: false, reason: `Ступень вне 1…${MATERIAL_STEPS}` };
  }
  return { ok: true, weaponClass, hands };
}
