import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { makeStubBvh } from './stubBvh.js';
import { parseCmd, fillArgs } from './cmd.js';
import { originAllowed, parseOrigins, keyMatches } from '../../packages/server/src/net/adminAccess.js';

/**
 * ШИМ ГЕНЕРАЦИИ АНИМАЦИЙ — единственное, чего не хватало каналу «текст → клип».
 *
 * Клиентская часть уже собрана целиком: вкладка AI поз-редактора шлёт
 * `POST {prompt, seconds, character, weapon}` и ждёт BVH (или наш клип), а `clipBaker` умеет
 * запекать BVH/GLB в `Clip` (`render3d/poseAiTab.ts`, `render3d/clipBaker.ts`). Не было только
 * сервиса на другом конце провода. Этот файл — он.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ПРОЦЕСС, А НЕ РОУТ В ИГРОВОМ СЕРВЕРЕ. Движок генерации живёт на другой машине,
 * весит больше десяти гигабайт и собирается своим тулчейном (C++/Vulkan либо Python/CUDA).
 * Игровой сервер не должен ни зависеть от него, ни падать вместе с ним.
 *
 * ДВА РЕЖИМА:
 *   --stub          отдаёт заведомо искусственный BVH. Ради него всё и сделано так: канал
 *                   проверяется на слабой машине, без весов, до того как движок вообще поставлен.
 *   ANIM_CMD=...    настоящий движок. Команда-шаблон, поэтому и kimodo.cpp, и вариант на PyTorch
 *                   подключаются без правок кода.
 *
 * ПЕРЕМЕННЫЕ:
 *   ANIM_PORT     (8790)              порт
 *   ANIM_KEY      (= DM_ADMIN_KEY)    ключ доступа; пустой — сервис не поднимется
 *   ANIM_ORIGINS  (дев-серверы)       белый список источников CORS
 *   ANIM_CMD                          шаблон команды движка; без неё нужен --stub
 *   ANIM_FPS      (30)                кадров в секунду
 *   ANIM_STEPS    (50)                шагов диффузии («скорость/качество»)
 *   ANIM_TIMEOUT  (600)               потолок на генерацию, секунд
 *   ANIM_MODEL    (—)                 что писать в /health как имя модели
 *   ANIM_DEVICE   (—)                 то же про устройство (cpu/vulkan/cuda)
 *
 * Подстановки в ANIM_CMD: {prompt} {seconds} {frames} {steps} {seed} {out}
 */

const PORT = Number(process.env.ANIM_PORT ?? 8790);
const KEY = process.env.ANIM_KEY ?? process.env.DM_ADMIN_KEY ?? '';
const ORIGINS = parseOrigins(process.env.ANIM_ORIGINS, 'http://localhost:5173,http://localhost:5174');
const CMD = process.env.ANIM_CMD ?? '';
const FPS = Math.max(1, Number(process.env.ANIM_FPS ?? 30));
const STEPS = Math.max(1, Number(process.env.ANIM_STEPS ?? 50));
const TIMEOUT_MS = Math.max(5, Number(process.env.ANIM_TIMEOUT ?? 600)) * 1000;
const STUB = process.argv.includes('--stub') || process.env.ANIM_BACKEND === 'stub';
const WORK = join(tmpdir(), 'dm-anim-ai');

/** Тип ответа по расширению файла, который написал движок. BVH — текст, GLB — двоичный. */
const MIME: Record<string, string> = { bvh: 'text/plain; charset=utf-8', glb: 'model/gltf-binary', gltf: 'model/gltf+json' };

interface GenRequest { prompt: string; seconds: number; character: string; weapon: string }

/** Запустить движок и вернуть путь к файлу, который он написал. */
async function runEngine(req: GenRequest): Promise<{ file: string; ext: string }> {
  await mkdir(WORK, { recursive: true });
  const argv = parseCmd(CMD);
  if (!argv.length) throw new Error('движок не настроен: задай ANIM_CMD или запусти с --stub');
  const id = randomUUID();
  // Расширение выходного файла берём из шаблона: движок сам решает, BVH он умеет или GLB.
  const ext = /\{out\}(?:\.(\w+))?/.exec(CMD)?.[1] ?? (/\.glb\b/.test(CMD) ? 'glb' : 'bvh');
  const out = join(WORK, `${id}.${ext}`);
  const frames = Math.max(2, Math.round(req.seconds * FPS));
  const args = fillArgs(argv, {
    prompt: req.prompt, seconds: String(req.seconds), frames: String(frames),
    steps: String(STEPS), seed: String((Math.random() * 2 ** 31) | 0), out,
  });

  const [bin, ...rest] = args;
  const proc = spawn(bin!, rest, { windowsHide: true });
  let err = '';
  proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
  proc.stdout.on('data', (d: Buffer) => { process.stdout.write(`[движок] ${d.toString()}`); });

  const code = await new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => { proc.kill(); reject(new Error(`движок не уложился в ${TIMEOUT_MS / 1000} с`)); }, TIMEOUT_MS);
    proc.on('error', (e) => { clearTimeout(t); reject(new Error(`не удалось запустить "${bin}": ${e.message}`)); });
    proc.on('close', (c) => { clearTimeout(t); resolve(c ?? -1); });
  });
  // Хвост stderr в ответ: без него автор видит только «сервис отказал» и гадает, что пошло не так.
  if (code !== 0) throw new Error(`движок вышел с кодом ${code}. ${err.trim().split('\n').slice(-3).join(' | ')}`);
  return { file: out, ext };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────
const json = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

function cors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (originAllowed(origin, req.headers.host, ORIGINS)) {
    if (origin) { res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'Origin'); }
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    return true;
  }
  return false;
}

/** Ключ, а не сессия: сервис безголовый, людям тут делать нечего. Тот же приём сравнения, что на сервере игры. */
function authed(req: IncomingMessage): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  return !!m && keyMatches(m[1]!, KEY, timingSafeEqual);
}

async function readBody(req: IncomingMessage): Promise<GenRequest> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new Error('слишком большой запрос');   // промпт — это текст, а не файл
    chunks.push(c as Buffer);
  }
  const b = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Partial<GenRequest>;
  const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
  if (!prompt) throw new Error('пустой запрос');
  return {
    prompt,
    seconds: Math.min(Math.max(Number(b.seconds) || 2, 0.2), 30),
    character: typeof b.character === 'string' ? b.character : '',
    weapon: typeof b.weapon === 'string' ? b.weapon : '',
  };
}

const server = createServer((req, res) => {
  void (async (): Promise<void> => {
    if (!cors(req, res)) { json(res, 403, { error: 'источник не разрешён' }); return; }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/health') {
      if (!authed(req)) { json(res, 401, { error: 'нужен ключ' }); return; }
      json(res, 200, {
        ok: true,
        backend: STUB ? 'stub' : (parseCmd(CMD)[0] ?? 'не настроен'),
        model: process.env.ANIM_MODEL ?? (STUB ? 'заглушка (движок не подключён)' : ''),
        device: process.env.ANIM_DEVICE ?? '',
        fps: FPS, steps: STEPS,
      });
      return;
    }

    if (req.method === 'POST' && path === '/gen') {
      if (!authed(req)) { json(res, 401, { error: 'нужен ключ' }); return; }
      let body: GenRequest;
      try { body = await readBody(req); } catch (e) { json(res, 400, { error: msg(e) }); return; }
      console.log(`[anim-ai] «${body.prompt}» · ${body.seconds}с · ${body.character || '—'}/${body.weapon || '—'}`);
      if (STUB) {
        res.writeHead(200, { 'content-type': MIME.bvh! });
        res.end(makeStubBvh({ seconds: body.seconds, fps: FPS }));
        return;
      }
      try {
        const t0 = Date.now();
        const { file, ext } = await runEngine(body);
        const data = await readFile(file);
        await rm(file, { force: true });
        console.log(`[anim-ai] готово за ${((Date.now() - t0) / 1000).toFixed(1)} с, ${data.length} байт (${ext})`);
        res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
        res.end(data);
      } catch (e) {
        console.warn('[anim-ai] отказ:', msg(e));
        json(res, 500, { error: msg(e) });   // редактор покажет этот текст автору как есть
      }
      return;
    }
    json(res, 404, { error: 'нет такого метода' });
  })().catch((e: unknown) => { console.error('[anim-ai]', e); if (!res.headersSent) json(res, 500, { error: msg(e) }); });
});

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Адреса, по которым сервис видно из локальной сети, — чтобы не искать их отдельно. */
function lanUrls(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list ?? []) if (n.family === 'IPv4' && !n.internal) out.push(`http://${n.address}:${PORT}`);
  }
  return out;
}

if (!KEY) {
  console.error('[anim-ai] не задан ANIM_KEY (или DM_ADMIN_KEY). Сервис без ключа не поднимается:');
  console.error('          он слушает локальную сеть и запускает процессы по запросу.');
  process.exit(1);
}
if (!STUB && !CMD) {
  console.error('[anim-ai] не задан ANIM_CMD и не указан --stub — генерировать нечем.');
  process.exit(1);
}
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[anim-ai] слушает :${PORT} · режим: ${STUB ? 'ЗАГЛУШКА (движок не подключён)' : 'движок ' + parseCmd(CMD)[0]}`);
  for (const u of lanUrls()) console.log(`[anim-ai]   адрес для вкладки AI: ${u}/gen`);
});
