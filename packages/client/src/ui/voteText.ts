import { isDifficultyUnlocked, type ConfigRegistry, type ServerFrame } from '@dm/shared';

/** Кадр начала голосования (`voteStart`). */
export type VoteStartFrame = Extract<ServerFrame, { t: 'voteStart' }>;

/** Экранирование для `innerHTML`: имена — авторский текст конфига, ник героя — текст игрока. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * ⭐ R9-08: ВОПРОС ОКНА ГОЛОСОВАНИЯ (HTML) — одно правило для 2D (`OnlineScene`) и 3D (`online3d`). Спуск из города — с тем, что
 * начнётся: новый забег или продолжение чьего забега и с какого этажа, сложность, шаблон, биом и модификаторы (сервер присылает
 * их в `voteStart`). Раньше оба окна знали только «Спуск на след. этаж?»: зовущий с открытым «кошмаром» звал «кошмар», а
 * принявший входил в тир, которого не открывал и не выбирал. `progress` — прогресс сложностей своего героя: закрытый ему тир
 * окно называет прямо. Имена — из своего конфига по id кадра; нет такого — сам id.
 */
export function voteQuestion(f: VoteStartFrame, cfg: ConfigRegistry, progress?: Record<string, number>): string {
  if (f.kind === 'town') return 'Вернуться в город?';
  if (f.kind === 'arena') return 'Войти в PvP-арену?';
  if (!f.difficultyId) return 'Спуск на след. этаж?';   // в подземелье: тир уже идёт, ветку показывает карта забега
  const nameOf = (list: readonly { id: string; name?: string }[], id: string | undefined): string =>
    esc(list.find((x) => x.id === id)?.name ?? id ?? '—');
  const diffs = cfg.get('difficulties');
  const tier = nameOf(diffs, f.difficultyId);
  const head = f.resume ? `Продолжить забег ${esc(f.resume.host)} с этажа ${f.resume.depth}?` : 'Новый забег?';
  const run = `${nameOf(cfg.get('run-templates'), f.templateId)} · ${nameOf(cfg.get('biomes'), f.biomeId)}`;
  const mods = f.modifiers?.length ? `<br>Модификаторы: ${f.modifiers.map((m) => nameOf(cfg.get('run-modifiers'), m)).join(', ')}` : '';
  const idx = diffs.findIndex((d) => d.id === f.difficultyId);
  const locked = progress && idx >= 0 && !isDifficultyUnlocked(diffs, idx, progress)
    ? `<br><b style="color:#e6a05a">Внимание: сложность «${tier}» вам ещё не открыта</b>`
    : '';
  return `${head}<br>Сложность: <b>${tier}</b> · ${run}${mods}${locked}`;
}
