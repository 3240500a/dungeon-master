import WebSocket from 'ws';
import { applyWorldDelta, worldChecksum, type ServerFrame, type WorldSnapshot } from '@dm/shared';

/**
 * Диагностика дельт (Ф1.3): один бот применяет дельты и при первом расхождении с полным
 * кадром печатает, ЧТО именно разошлось. Нужен, когда стенд говорит «расхождения есть»,
 * но не говорит где.
 *
 *   npm run poc:delta
 */
const BASE = process.argv.find((a) => a.startsWith('--base='))?.slice(7) ?? 'http://127.0.0.1:3999';

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

/** Первое расхождение между реконструкцией и истиной, человеческим языком. */
function firstDiff(mine: WorldSnapshot, truth: WorldSnapshot): string | null {
  const cmp = <T extends { id: string | number }>(kind: string, a: readonly T[], b: readonly T[]): string | null => {
    const am = new Map(a.map((e) => [String(e.id), e]));
    const bm = new Map(b.map((e) => [String(e.id), e]));
    for (const id of bm.keys()) if (!am.has(id)) return `${kind} ${id}: есть в истине, нет у меня`;
    for (const id of am.keys()) if (!bm.has(id)) return `${kind} ${id}: есть у меня, нет в истине`;
    for (const [id, mineE] of am) {
      const truthE = bm.get(id)! as Record<string, unknown>;
      const m = mineE as Record<string, unknown>;
      const keys = new Set([...Object.keys(m), ...Object.keys(truthE)]);
      for (const k of keys) {
        const x = JSON.stringify(m[k]);
        const y = JSON.stringify(truthE[k]);
        if (x !== y) return `${kind} ${id}.${k}: у меня ${x}, в истине ${y}`;
      }
    }
    return null;
  };
  return cmp('игрок', mine.players, truth.players)
    ?? cmp('монстр', mine.monsters, truth.monsters)
    ?? cmp('дроп', mine.drops, truth.drops);
}

async function main(): Promise<void> {
  const username = `dc_${Math.random().toString(36).slice(2, 8)}`;
  const { token } = await post<{ token: string }>('/api/register', { username, password: 'loadtest-password' });
  const { character } = await post<{ character: { charId: string } }>('/api/characters', { classId: 'warrior', name: 'DC' }, token);

  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
  let world: WorldSnapshot | undefined;
  let applied = 0;
  let pending: WorldSnapshot | undefined;
  let checks = 0;
  let bad = 0;

  ws.on('open', () => ws.send(JSON.stringify({ t: 'join', token, charId: character.charId, fresh: true })));
  ws.on('message', (data: Buffer) => {
    const f = JSON.parse(data.toString()) as ServerFrame;
    if (f.t === 'joined') setTimeout(() => ws.send(JSON.stringify({ t: 'descend', difficultyId: 'normal' })), 1200);
    else if (f.t === 'voteStart') ws.send(JSON.stringify({ t: 'vote', accept: true }));
    else if (f.t === 'snapDelta') {
      if (!world) return;
      world = applyWorldDelta(world, f.delta);
      applied++;
      checks++;
      if (worldChecksum(world) !== f.sum) {
        bad++;
        if (bad <= 5) console.log(`расхождение #${bad} на тике ${f.delta.t} (дельт с полного кадра: ${applied})`);
        pending = world; // сверим состав по ближайшему полному кадру — покажет, ЧТО именно уехало
      }
    }
    else if (f.t === 'snapshot') {
      if (pending) {
        const diff = firstDiff(pending, f.snap);
        console.log(`  ближайший полный кадр (тик позже) отличается так: ${diff ?? 'состав совпадает, разошлись только величины'}`);
        pending = undefined;
      }
      world = f.snap;
      applied = 0;
    }
  });

  // Двигаемся и бьём — иначе мир статичен и дельты пустые.
  const iv = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    const a = Math.random() * 6.28;
    ws.send(JSON.stringify({ t: 'input', seq: 0, input: { move: { x: Math.cos(a), y: Math.sin(a) }, facing: a, attack: true, cast: null, interact: false } }));
  }, 1000 / 30);

  await new Promise((r) => setTimeout(r, 30_000));
  clearInterval(iv);
  ws.close();
  console.log(`\nИТОГ: сверок ${checks}, расхождений ${bad}`);
  process.exit(bad === 0 && checks > 0 ? 0 : 1);
}

void main();
