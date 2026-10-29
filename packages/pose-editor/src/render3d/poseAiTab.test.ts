import { describe, it, expect } from 'vitest';
import { requestGeneration, checkHealth, looksLikeBvh, generatedClipName, DEFAULT_AI_CONFIG } from './poseAiTab.js';

const REQ = { prompt: 'взмах мечом', seconds: 2, character: 'warrior', weapon: 'sword' };
const mkRes = (body: string, ct: string, ok = true, status = 200): Response =>
  ({ ok, status, headers: { get: () => ct }, json: async () => JSON.parse(body) as unknown, text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer }) as unknown as Response;

describe('poseAiTab — запрос к сервису', () => {
  it('без адреса — внятная ошибка, а не тишина', async () => {
    expect((await requestGeneration(DEFAULT_AI_CONFIG(), REQ)).error).toContain('адрес');
  });

  it('текстовый ответ трактуется как BVH', async () => {
    const r = await requestGeneration({ url: 'x', prompt: '', seconds: 2 }, REQ, '',
      (async () => mkRes('HIERARCHY\nROOT Hips\nMOTION\nFrames: 2', 'text/plain')) as unknown as typeof fetch);
    expect(r.bvh).toContain('HIERARCHY');
  });

  it('JSON-ответ с клипом принимается как есть', async () => {
    const clip = { name: 'x', character: 'a', weapon: 'sword', loop: false, keys: [] };
    const r = await requestGeneration({ url: 'x', prompt: '', seconds: 2 }, REQ, '',
      (async () => mkRes(JSON.stringify({ clip }), 'application/json')) as unknown as typeof fetch);
    expect(r.clip!.name).toBe('x');
  });

  it('JSON без clip/bvh — ошибка, а не «успех с пустотой»', async () => {
    const r = await requestGeneration({ url: 'x', prompt: '', seconds: 2 }, REQ, '',
      (async () => mkRes('{"status":"ok"}', 'application/json')) as unknown as typeof fetch);
    expect(r.error).toBeTruthy();
  });

  it('HTTP-ошибка и обрыв сети сообщаются, а не глотаются', async () => {
    const bad = await requestGeneration({ url: 'x', prompt: '', seconds: 2 }, REQ, '',
      (async () => mkRes('', 'text/plain', false, 503)) as unknown as typeof fetch);
    expect(bad.error).toContain('503');
    const down = await requestGeneration({ url: 'x', prompt: '', seconds: 2 }, REQ, '',
      (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    expect(down.error).toContain('сеть');
  });

  it('пустой текстовый ответ — ошибка', async () => {
    const r = await requestGeneration({ url: 'x', prompt: '', seconds: 2 }, REQ, '',
      (async () => mkRes('   ', 'text/plain')) as unknown as typeof fetch);
    expect(r.error).toBeTruthy();
  });
});

describe('poseAiTab — двоичный ответ и ключ', () => {
  /**
   * ГЛАВНОЕ ЗДЕСЬ: `kimodo.cpp` отдаёт СКЕЛЕТНЫЙ GLB, а не BVH. Старая ветка
   * «всё не-JSON — текст» прогнала бы его через UTF-8 и испортила байты безвозвратно.
   */
  it('GLB приходит БАЙТАМИ, а не текстом', async () => {
    const r = await requestGeneration({ url: 'x', prompt: '', seconds: 2 }, REQ, '',
      (async () => mkRes('glTF\u0000\u0002binary', 'model/gltf-binary')) as unknown as typeof fetch);
    expect(r.glb).toBeInstanceOf(ArrayBuffer);
    expect(r.bvh).toBeUndefined();
    expect(r.glb!.byteLength).toBeGreaterThan(0);
  });

  it('пустой двоичный ответ — ошибка, а не клип из нуля байт', async () => {
    const r = await requestGeneration({ url: 'x', prompt: '', seconds: 2 }, REQ, '',
      (async () => mkRes('', 'application/octet-stream')) as unknown as typeof fetch);
    expect(r.error).toBeTruthy();
  });

  it('ключ уходит заголовком, а без ключа заголовка нет', async () => {
    let seen: Record<string, string> = {};
    const spy = (async (_u: string, init: RequestInit) => { seen = init.headers as Record<string, string>; return mkRes('HIERARCHY MOTION', 'text/plain'); }) as unknown as typeof fetch;
    await requestGeneration({ url: 'x', prompt: '', seconds: 2 }, REQ, 's3cret', spy);
    expect(seen.authorization).toBe('Bearer s3cret');
    await requestGeneration({ url: 'x', prompt: '', seconds: 2 }, REQ, '', spy);
    expect(seen.authorization).toBeUndefined();
  });

  it('401 называется своим именем — «сервис ответил 401» ничего не подсказывает', async () => {
    const r = await requestGeneration({ url: 'x', prompt: '', seconds: 2 }, REQ, 'bad',
      (async () => mkRes('{}', 'application/json', false, 401)) as unknown as typeof fetch);
    expect(r.error).toContain('ключ');
  });

  it('причина отказа берётся из тела ответа, а не только статус', async () => {
    const r = await requestGeneration({ url: 'x', prompt: '', seconds: 2 }, REQ, '',
      (async () => mkRes('{"error":"движок не уложился"}', 'application/json', false, 500)) as unknown as typeof fetch);
    expect(r.error).toContain('движок не уложился');
  });
});

describe('poseAiTab — проверка связи', () => {
  it('адрес /gen превращается в /health того же сервиса', async () => {
    let url = '';
    const spy = (async (u: string) => { url = u; return mkRes('{"ok":true,"backend":"stub"}', 'application/json'); }) as unknown as typeof fetch;
    await checkHealth({ url: 'http://192.168.1.9:8790/gen', prompt: '', seconds: 2 }, 'k', spy);
    expect(url).toBe('http://192.168.1.9:8790/health');
    await checkHealth({ url: 'http://192.168.1.9:8790/gen/', prompt: '', seconds: 2 }, 'k', spy);
    expect(url).toBe('http://192.168.1.9:8790/health');
  });

  it('возвращает что на том конце, а отказы называет вслух', async () => {
    const ok = await checkHealth({ url: 'x', prompt: '', seconds: 2 }, 'k',
      (async () => mkRes('{"ok":true,"backend":"kimodo.cpp","device":"vulkan"}', 'application/json')) as unknown as typeof fetch);
    expect(ok.backend).toBe('kimodo.cpp');
    expect(ok.device).toBe('vulkan');
    const down = await checkHealth({ url: 'x', prompt: '', seconds: 2 }, 'k',
      (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    expect(down.error).toContain('сеть');
    expect((await checkHealth(DEFAULT_AI_CONFIG(), 'k')).error).toContain('адрес');
  });
});

describe('poseAiTab — распознавание BVH', () => {
  it('настоящий BVH принимается, мусор — нет', () => {
    expect(looksLikeBvh('HIERARCHY\nROOT Hips\n{\n}\nMOTION\nFrames: 3')).toBe(true);
    expect(looksLikeBvh('  hierarchy ... motion ')).toBe(true);
    expect(looksLikeBvh('<html>404</html>')).toBe(false);
    expect(looksLikeBvh('HIERARCHY только, без движения')).toBe(false);
  });
});

describe('poseAiTab — имя клипа', () => {
  it('строится из запроса и не конфликтует', () => {
    expect(generatedClipName('взмах мечом', [])).toBe('ai_взмах_мечом');
    expect(generatedClipName('взмах мечом', ['ai_взмах_мечом'])).toBe('ai_взмах_мечом_2');
    expect(generatedClipName('!!!', [])).toBe('ai_clip');
  });

  it('длинный запрос обрезается', () => {
    expect(generatedClipName('a'.repeat(80), []).length).toBeLessThanOrEqual(27);
  });
});
