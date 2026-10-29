import type { ConfigRegistry } from '../config/registry.js';
import { runNodeLabel } from '../dungeon/run/labels.js';
import { cfgTextOf, isNum, richEsc, str, type CfgText, type RunViewOptions } from './runCommon.js';

/**
 * ⭐⭐ С-views (29.10): ВОПРОС ОКНА ГОЛОСОВАНИЯ — текст считает СЕРВЕР, для КАЖДОГО получателя свой.
 *
 * Порт `VoteText.Question` (Unity `Assets/DM/UI/VoteText.cs`): разметка — rich text Unity (`<b>`, `<color=#…>`), имена из
 * конфига и ник хозяина забега обезврежены (`‹›`). Зависит от получателя ровно одной строкой — предупреждением «сложность вам
 * ещё не открыта» (по ЕГО `difficultyProgress`), поэтому сервер кладёт вопрос в `voteStart` каждому клиенту отдельно.
 *
 * ⚠ ОДНО РАСХОЖДЕНИЕ С ОКНОМ UNITY — НАРОЧНО: стартовая глубина. Сервер присылает в `voteStart` `startDepth`, УЖЕ зажатый по
 * рекордам всей пати (`waypointStart`), ровно затем, чтобы окно назвало, ГДЕ начнётся спуск («окно ≡ исход», Г3 В2); веб-окно так
 * и говорит («Новый забег с этажа 18?»), а порт Unity поле молча терял — хотя подсказка самого портала обещает игроку, что «точную
 * глубину назовёт окно голосования». Вид следует серверу и вебу.
 */

/** Кадр `voteStart` (поля, которые читает вопрос). */
export interface RunVoteFrame {
  kind?: string;
  finish?: boolean;
  targetNodeType?: string;
  difficultyId?: string;
  biomeId?: string;
  modifiers?: readonly unknown[];
  startDepth?: number;
  resume?: { host?: unknown; depth?: unknown } | null;
}

/** Строка конфига для вопроса: только `id`/`name`/`unlockFloor`. */
type Row = { id?: unknown; name?: unknown; unlockFloor?: unknown };
/** Конфиг вопроса: реестр сервера или голые таблицы (стенды, эталон). */
export type RunVoteCfg = ConfigRegistry | { difficulties?: readonly Row[]; biomes?: readonly Row[]; 'run-modifiers'?: readonly Row[] };

function tableOf(cfg: RunVoteCfg, key: 'difficulties' | 'biomes' | 'run-modifiers'): readonly Row[] {
  if (typeof (cfg as ConfigRegistry).get === 'function') {
    try { return (cfg as ConfigRegistry).get(key) as readonly Row[]; } catch { return []; }
  }
  const t = (cfg as Record<string, unknown>)[key];
  return Array.isArray(t) ? (t as Row[]) : [];
}

/**
 * Открыт ли тир `index` (C# `VoteText.DifficultyUnlocked` ≡ `isDifficultyUnlocked`, но по ГОЛЫМ строкам: стенды и эталон шлют
 * тиры без полей схемы). Вне списка — открыт.
 */
export function runDifficultyUnlocked(diffs: readonly Row[], index: number, progress: Readonly<Record<string, unknown>> | null | undefined): boolean {
  if (index < 0 || index >= diffs.length) return true;
  const unlock = isNum(diffs[index]?.unlockFloor) ? (diffs[index]!.unlockFloor as number) : 0;
  if (!(unlock > 0)) return true;
  if (index === 0) return true;
  const prevId = str(diffs[index - 1]?.id);
  const have = prevId !== null && isNum(progress?.[prevId]) ? (progress![prevId] as number) : 0;
  return have >= unlock;
}

/**
 * ⭐⭐ ВОПРОС ГОЛОСОВАНИЯ (C# `VoteText.Question`). Сервер: `runVoteQuestion(frame, this.cfg, player.save.difficultyProgress)` —
 * на каждого получателя `voteStart`. `progress` не передан — без предупреждения о закрытом тире (как у C# с `null`).
 */
export function runVoteQuestion(f: RunVoteFrame, cfg: RunVoteCfg, progress?: Readonly<Record<string, unknown>> | null, opts?: RunViewOptions): string {
  const tx: CfgText = cfgTextOf(typeof (cfg as ConfigRegistry).get === 'function' ? (cfg as ConfigRegistry) : undefined, opts);
  const kind = str(f?.kind);
  if (kind === 'town') return 'Вернуться в город?';
  if (kind === 'arena') return 'Войти в PvP-арену?';
  if (f?.finish === true) return 'Завершить забег и вернуться в город?';
  const target = str(f?.targetNodeType);
  if (target) return `Спуск: ${richEsc(runNodeLabel(target))}?`;
  const diffId = str(f?.difficultyId);
  if (!diffId) return 'Спуск на след. этаж?';   // кадр без цели — тир уже идёт
  const nameOf = (table: 'difficulties' | 'biomes' | 'run-modifiers', id: string | null): string => {
    if (id !== null) {
      for (const x of tableOf(cfg, table)) {
        if (str(x?.id) !== id) continue;
        const name = str(x.name);
        return richEsc(name !== null ? tx(table, [id], 'name', name) : id);
      }
    }
    return richEsc(id ?? '—');
  };
  const diffs = tableOf(cfg, 'difficulties');
  const tier = nameOf('difficulties', diffId);
  const host = f.resume && typeof f.resume === 'object' ? str(f.resume.host) : null;
  const sd = f.startDepth;
  const head = host !== null
    ? `Продолжить забег ${richEsc(host)} с этажа ${Number.isInteger(f.resume!.depth) ? (f.resume!.depth as number) : 0}?`
    : isNum(sd) && sd > 1 ? `Новый забег с этажа ${sd}?` : 'Новый забег?';
  const run = nameOf('biomes', str(f.biomeId));
  const mods = Array.isArray(f.modifiers) ? f.modifiers.filter((m): m is string => typeof m === 'string').map((m) => nameOf('run-modifiers', m)) : [];
  const modLine = mods.length > 0 ? `\nМодификаторы: ${mods.join(', ')}` : '';
  const idx = diffs.findIndex((d) => str(d?.id) === diffId);
  const locked = progress != null && idx >= 0 && !runDifficultyUnlocked(diffs, idx, progress)
    ? `\n<b><color=#e6a05a>Внимание: сложность «${tier}» вам ещё не открыта</color></b>`
    : '';
  return `${head}\nСложность: <b>${tier}</b> · ${run}${modLine}${locked}`;
}
