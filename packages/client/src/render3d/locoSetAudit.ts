/**
 * ⭐⭐ ПОКРЫТИЕ НАБОРА ЛОКОМОЦИИ: у кого есть походка, у кого нет и что протухло.
 *
 * Зачем. Игра ходит ТОЛЬКО клипами, а набор есть не у всех: кукла без набора остаётся на планировщике, монстры
 * ходят набором персонажа-донора. Пока это нигде не показано, состояние контента — догадка: «вроде запекал». Ровно
 * этот вопрос встаёт первым, когда автор садится делать походки монстрам.
 *
 * ⚠ МОДУЛЬ НИЧЕГО НЕ ЧИНИТ И НЕ ПЕЧЁТ. Он отвечает на вопрос «что сейчас есть» — и отвечает ТЕМИ ЖЕ функциями
 * поиска, которыми пользуется рантайм (`findLocoClip`, `bakedLocoSpeed`, `isLocoClipFresh`). Свой разбор здесь был
 * бы второй правдой: она разойдётся с первой молча, и врать начнёт именно панель, по которой принимают решение.
 *
 * Чистый модуль (только данные клипов) — тестируется в node.
 */
import { findLocoClip, bakedLocoSpeed, locoClipNames, LOCO_DIRS, LOCO_BAKE_WALK_SPD, LOCO_BAKE_RUN_SPD } from './locoBlend.js';
import { TURN_NAMES, SWING_KEY } from './turnInPlace.js';
import { isLocoClipFresh, LOCO_BAKE_REV } from './poseRuntime.js';
import type { Clip } from './clipModel.js';

/** Что именно не так с клипом (или с его отсутствием). Порядок — по убыванию тяжести. */
export type DefectKind =
  | 'missing'       // клипа нет вовсе, и донор его тоже не даёт — кукла останется на планировщике
  | 'fallback'      // своего нет, играет донорский: работает, но походка чужая
  | 'stale_rev'     // снят С ДОВОРОТОМ (до кардинальной ревизии) — сектора доворота на нём выключены
  | 'stale_speed'   // снят на другой скорости, чем нынешний пресет: стопы поедут на разницу
  | 'dirty_upper'   // в руки впечена стойка — при проигрывании вес стойки ложится ВТОРОЙ раз
  | 'no_swing'      // нет канала опоры: окно опоры угадывается по доле `dutyRun`
  | 'no_ref'        // нет нейтрали маха: считается на лету (работает, но лишняя работа в кадре)
  | 'split_bake'    // клипы набора сняты РАЗНЫМИ прогонами — настройки между ними могли поменяться
  | 'weapon_tag';   // набор помечен ОРУЖИЕМ, хотя руки в нём безоружные — перезапекание разойдётся по оружиям

export interface Defect {
  charId: string;
  /** Имя клипа, которого не хватает или который протух. */
  name: string;
  kind: DefectKind;
  /** Человеческая подпись — её и показывает панель. */
  note: string;
  /** Чей клип реально играет (для `fallback`). */
  from?: string;
}

export interface CharCoverage {
  charId: string;
  /** Сколько имён из тех, что спрашивает движок, закрыто СВОИМИ клипами. */
  own: number;
  /** …и сколько закрыто донорскими. */
  borrowed: number;
  /** Всего спрашиваемых имён. */
  total: number;
  defects: Defect[];
}

/** Имена, которые спрашивает движок: ход (4 направления × ходьба/бег) + стойка + повороты на месте. */
export const REQUIRED_NAMES: readonly string[] = [
  ...[false, true].flatMap((fast) => LOCO_DIRS.map((d) => locoClipNames(d, fast)[0]!)),
  'idle',
  ...TURN_NAMES,
];
/** Скорость, на которой пресет снимается сейчас. Ходьба/бег — по префиксу имени; у стойки и поворотов её нет. */
const presetSpeed = (name: string): number | null =>
  name.startsWith('run_') ? LOCO_BAKE_RUN_SPD : name.startsWith('walk_') ? LOCO_BAKE_WALK_SPD : null;
const isGait = (name: string): boolean => name.startsWith('run_') || name.startsWith('walk_');
const hasSwing = (c: Clip): boolean => c.keys.some((k) => !!k.pose[SWING_KEY]);

/**
 * Аудит одного персонажа. `weapon` — ключ оружия, под который ищется набор (у набора он обычно `none`:
 * один набор на все оружия, см. `findLocoClip`).
 */
export function auditChar(clips: readonly Clip[], charId: string, fallbackId?: string, weapon = 'none'): CharCoverage {
  const defects: Defect[] = [];
  let own = 0, borrowed = 0;
  const bakeIds = new Set<number>();
  for (const name of REQUIRED_NAMES) {
    // ⚠⚠ ТЕГ ОРУЖИЯ У НАБОРА ХОДА. Запекатель ПРИНУДИТЕЛЬНО гасит авторскую стойку (`setLayerBakeOverride`), то есть
    // руки в клипе всегда безоружные — а тег до 19.09 брался из текущего выбора редактора. Снял набор при выбранном
    // мече → он лёг тегом `sword`. Ключ дедупа библиотеки — тройка (имя, персонаж, ОРУЖИЕ), поэтому следующее
    // запекание при другом выборе НЕ заменяет набор, а кладёт ВТОРОЙ рядом. Дальше `findLocoClip` выдаёт каждому
    // оружию свой: под мечом играет один набор, под топором — другой, и автор видит «перезапёк, а половина
    // настроек не доехала». Ровно этот класс жалобы.
    const tagged = clips.filter((c) => c.name === name && c.character === charId);
    const bad = tagged.filter((c) => (c.weapon ?? 'none') !== 'none');
    if (bad.length && isGait(name)) {
      const tags = [...new Set(bad.map((c) => c.weapon))].join(', ');
      defects.push({ charId, name, kind: 'weapon_tag',
        note: tagged.length > bad.length || bad.length > 1
          ? `набор раздвоился по оружию (${tags}) — разным оружиям играют РАЗНЫЕ клипы под одним именем`
          : `помечен оружием «${tags}», хотя руки в нём безоружные — перезапекание под другим оружием ляжет рядом` });
    }
    const mine = findLocoClip(clips, name, charId, weapon);
    const c = mine ?? (fallbackId ? findLocoClip(clips, name, fallbackId, weapon) : null);
    if (!c) {
      defects.push({ charId, name, kind: 'missing', note: 'клипа нет ни у себя, ни у донора — кукла останется на планировщике' });
      continue;
    }
    if (!mine) {
      borrowed++;
      defects.push({ charId, name, kind: 'fallback', from: fallbackId, note: `своего нет — играет клип «${fallbackId ?? '?'}»` });
      continue;
    }
    own++;
    if (typeof c.bakeId === 'number') bakeIds.add(c.bakeId);
    if (!isGait(name)) continue;                       // дальше — только про клипы ХОДА: у стойки и поворотов этих полей нет
    const want = presetSpeed(name);
    const got = bakedLocoSpeed(c);
    if (want !== null && Math.abs(got - want) > 0.5) {
      defects.push({ charId, name, kind: 'stale_speed', note: `снят на ${Math.round(got)} u/с, пресет сейчас ${want} — стопы поедут на разницу` });
    } else if (!isLocoClipFresh(c)) {
      defects.push({ charId, name, kind: 'stale_rev', note: 'снят С ДОВОРОТОМ таза — сектора доворота на нём выключены' });
    }
    if (c.bakeSpeed !== undefined && !c.upperPure) {
      defects.push({ charId, name, kind: 'dirty_upper', note: 'в руки впечена стойка — при проигрывании её вес ложится второй раз' });
    }
    if (!hasSwing(c)) defects.push({ charId, name, kind: 'no_swing', note: 'нет канала опоры — окно опоры угадывается по доле' });
    if (!c.swingRef) defects.push({ charId, name, kind: 'no_ref', note: 'нет нейтрали маха — считается на лету' });
  }
  // ⚠ РАЗНЫЕ ПРОГОНЫ — отдельный дефект, а не придирка: между съёмами автор мог покрутить ручки походки, и тогда
  // клипы набора описывают РАЗНЫЕ походки. Поймать это иначе нечем — по самим позам не видно.
  if (bakeIds.size > 1) {
    defects.push({ charId, name: '—', kind: 'split_bake', note: `клипы сняты ${bakeIds.size} разными прогонами — между ними могли поменяться настройки` });
  }
  return { charId, own, borrowed, total: REQUIRED_NAMES.length, defects };
}

/** Аудит по всем персонажам роста. */
export function auditLocoSet(clips: readonly Clip[], charIds: readonly string[], fallbackId?: string, weapon = 'none'): CharCoverage[] {
  return charIds.map((id) => auditChar(clips, id, id === fallbackId ? undefined : fallbackId, weapon));
}

/** Дефекты, которые лечит ПЕРЕЗАПЕКАНИЕ (остальные — про отсутствующий контент или чужой набор). */
export const REBAKEABLE: ReadonlySet<DefectKind> = new Set<DefectKind>(['stale_rev', 'stale_speed', 'dirty_upper', 'no_swing', 'no_ref', 'split_bake']);
/** Имена клипов персонажа, которые стоит перезапечь (для кнопки «перезапечь протухшее»). */
export const staleNames = (cov: CharCoverage): string[] =>
  [...new Set(cov.defects.filter((d) => REBAKEABLE.has(d.kind) && d.name !== '—').map((d) => d.name))];

/** Насколько это срочно: по худшему дефекту. `ok` — своих клипов хватает и они свежие. */
export type Severity = 'ok' | 'info' | 'warn' | 'block';
export const severityOf = (cov: CharCoverage): Severity => {
  if (cov.defects.some((d) => d.kind === 'missing')) return 'block';
  if (cov.defects.some((d) => d.kind === 'stale_rev' || d.kind === 'stale_speed' || d.kind === 'dirty_upper' || d.kind === 'split_bake' || d.kind === 'weapon_tag')) return 'warn';
  if (cov.defects.length) return 'info';
  return 'ok';
};
/** Текущая ревизия запекателя — панель показывает её рядом, чтобы «протухло» не выглядело гаданием. */
export const CURRENT_BAKE_REV = LOCO_BAKE_REV;
