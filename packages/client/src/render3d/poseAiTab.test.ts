import { describe, it, expect } from 'vitest';
import { requestGeneration, looksLikeBvh, generatedClipName, DEFAULT_AI_CONFIG } from './poseAiTab.js';

const REQ = { prompt: 'взмах мечом', seconds: 2, character: 'warrior', weapon: 'sword' };
const mkRes = (body: string, ct: string, ok = true, status = 200): Response =>
  ({ ok, status, headers: { get: () => ct }, json: async () => JSON.parse(body) as unknown, text: async () => body }) as unknown as Response;

describe('poseAiTab — запрос к сервису', () => {
  it('без адреса — внятная ошибка, а не тишина', async () => {
    expect((await requestGeneration(DEFAULT_AI_CONFIG(), REQ)).error).toContain('адрес');
  });

  it('текстовый ответ трактуется как BVH', async () => {
    const r = await requestGeneration({ url: 'x', prompt: '', seconds: 2 }, REQ,
      (async () => mkRes('HIERARCHY\nROOT Hips\nMOTION\nFrames: 2', 'text/plain')) as unknown as typeof fetch);
    expect(r.bvh).toContain('HIERARCHY');
  });

  it('JSON-ответ с клипом принимается как есть', async () => {
    const clip = { name: 'x', character: 'a', weapon: 'sword', loop: false, keys: [] };
    const r = await requestGeneration({ url: 'x', prompt: '', seconds: 2 }, REQ,
      (async () => mkRes(JSON.stringify({ clip }), 'application/json')) as unknown as typeof fetch);
    expect(r.clip!.name).toBe('x');
  });

  it('JSON без clip/bvh — ошибка, а не «успех с пустотой»', async () => {
    const r = await requestGeneration({ url: 'x', prompt: '', seconds: 2 }, REQ,
      (async () => mkRes('{"status":"ok"}', 'application/json')) as unknown as typeof fetch);
    expect(r.error).toBeTruthy();
  });

  it('HTTP-ошибка и обрыв сети сообщаются, а не глотаются', async () => {
    const bad = await requestGeneration({ url: 'x', prompt: '', seconds: 2 }, REQ,
      (async () => mkRes('', 'text/plain', false, 503)) as unknown as typeof fetch);
    expect(bad.error).toContain('503');
    const down = await requestGeneration({ url: 'x', prompt: '', seconds: 2 }, REQ,
      (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    expect(down.error).toContain('сеть');
  });

  it('пустой текстовый ответ — ошибка', async () => {
    const r = await requestGeneration({ url: 'x', prompt: '', seconds: 2 }, REQ,
      (async () => mkRes('   ', 'text/plain')) as unknown as typeof fetch);
    expect(r.error).toBeTruthy();
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
