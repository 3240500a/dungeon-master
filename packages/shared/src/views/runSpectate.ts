/**
 * ⭐ С-views (29.10): НАБЛЮДЕНИЕ ЗА СОЮЗНИКОМ ПОСЛЕ СМЕРТИ — за кем камера и подпись.
 *
 * Порт `Spectate.Frame/Tab/Hint` (Unity `Assets/DM/Net/Spectate.cs`). ⚠ Это НЕ правило сервера, а выбор показа: Tab — клавиша
 * игрока, живость союзников клиент и так читает из снимка мира. Порт нужен затем, чтобы подпись (единственный текст здесь)
 * имела один источник, если её когда-нибудь пришлёт сервер; сглаживание фокуса (`Spectate.Smooth`) — чистая отрисовка камеры
 * и остаётся в Unity вместе с камерой и затуханием стен.
 */

export interface RunSpectPlayer { id: string; alive: boolean; name?: string | null }

/** Подпись (C# `Spectate.Hint`): безымянный союзник — «союзник». */
export function runSpectateHint(name: string | null | undefined): string {
  return `💀 Наблюдаете за ${name ? name : 'союзник'} · Tab — сменить`;
}

/** Кадр мира (C# `Spectate.Frame`): выбранный союзник, фокус камеры и подпись (null — подписи нет). */
export function runSpectateFrame(players: readonly RunSpectPlayer[], myId: string, spectateId: string | null):
  { spectateId: string | null; focus: string | null; hint: string | null } {
  const me = players.find((p) => p.id === myId);
  if (!me) return { spectateId, focus: null, hint: null };
  if (me.alive) return { spectateId: null, focus: myId, hint: null };
  const living = players.filter((p) => p.id !== myId && p.alive);
  if (!living.length) return { spectateId, focus: null, hint: null };
  const chosen = (spectateId !== null ? living.find((p) => p.id === spectateId) : undefined) ?? living[0]!;
  return { spectateId: chosen.id, focus: chosen.id, hint: runSpectateHint(chosen.name ?? '') };
}

/** Tab (C# `Spectate.Tab`): мёртвый и два+ живых союзника — следующий по кругу; `used` — клавиша съедена. */
export function runSpectateTab(players: readonly RunSpectPlayer[], myId: string, spectateId: string | null): { spectateId: string | null; used: boolean } {
  const me = players.find((p) => p.id === myId);
  if (!me || me.alive) return { spectateId, used: false };
  const living = players.filter((p) => p.id !== myId && p.alive);
  if (living.length < 2) return { spectateId, used: false };
  const at = living.findIndex((p) => p.id === spectateId);
  return { spectateId: living[(at + 1) % living.length]!.id, used: true };
}
