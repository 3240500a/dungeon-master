import { parentPort } from 'node:worker_threads';
import type { ConfigRegistry } from '@dm/shared';
import { bakeCraftGlb, depsRegistry } from './bake.js';
import type { FromWorker, ToWorker } from './protocol.js';

/**
 * ПОТОК ПЕЧИ МОДЕЛЕЙ ИЗ ДЕТАЛЕЙ. Здесь — и только здесь — живут `three`, экспортёр GLB и построители: главный поток (тик
 * комнат одиночного процесса, ручки гейтвея) их не грузит и печью не занят. Запуск — `workerBoot.mjs` (TS через tsx),
 * хозяин — `baker.ts`. Падение работы — кадр отказа, а не падение потока.
 */
const port = parentPort;
if (!port) throw new Error('craftMesh/worker.ts — только поток печи (worker_threads)');

let reg: ConfigRegistry | null = null;
let rev = '';
let configError = '';

const send = (m: FromWorker, transfer?: ArrayBuffer[]): void => port.postMessage(m, transfer);
const why = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

port.on('message', (m: ToWorker) => {
  if (m.t === 'config') {
    try { reg = depsRegistry(m.tables); rev = m.rev; configError = ''; }
    catch (e) { reg = null; rev = ''; configError = why(e); console.warn('[craft-mesh] конфиг печи не собрался:', configError); }
    return;
  }
  if (m.t !== 'bake') return;
  if (!reg || m.rev !== rev) {
    send({ t: 'fail', id: m.id, kind: 'failed', reason: configError ? 'конфиг печи не собрался' : 'печь не на той ревизии конфига' });
    return;
  }
  const at = reg;
  void bakeCraftGlb(at, m.weaponClass, m.hands, m.parts, { look: m.look, rev: m.rev }).then(
    (glb) => {
      if (!glb) { send({ t: 'fail', id: m.id, kind: 'unbuildable', reason: 'Модель этого вида не строится' }); return; }
      send({ t: 'done', id: m.id, glb }, [glb.buffer as ArrayBuffer]);
    },
    // ⚠ Исключение — не «вид не строится»: бывает и сбой мгновения (память). Наружу — общая фраза, подробность — в журнал потока;
    // повторы одного вида считает служба (`service.ts`): упал трижды подряд — тогда несобираемый.
    (e: unknown) => {
      console.warn(`[craft-mesh] построитель упал на «${m.look}»:`, why(e));
      send({ t: 'fail', id: m.id, kind: 'error', reason: 'Построитель модели упал' });
    },
  );
});

send({ t: 'ready' });
