import type { Express } from 'express';
import type { ConfigRegistry } from '@dm/shared';
import { ah, queryText } from './asyncRoute.js';
import { bearer } from './accountRoutes.js';
import { knownSession, sessionUser } from './authSession.js';
import { clientIp, ipBucket, limits } from './rateLimit.js';
import { checkLook, parseLook } from '../craftMesh/look.js';
import { CraftMeshService } from '../craftMesh/service.js';
import { GlbCache } from '../craftMesh/cache.js';

/**
 * ⭐ U6b · МОДЕЛЬ ОРУЖИЯ ИЗ ДЕТАЛЕЙ — GLB С СЕРВЕРА (решение Р2 плана Unity; docs/CRAFT_WEAPONS.md §21.1).
 *
 * `GET /api/craft-mesh.glb?look=<подпись вида>` (`Authorization: Bearer <токен сессии>`) → `model/gltf-binary`: модель, которую
 * веб-клиент строит у себя (`craftMesh`), испечённая тем же построителем. Unity грузит её glTFast и ставит свои материалы по
 * именам — форма у клиентов одна, потому что построитель один (геометрия клинка кормит его статы: второй построитель был бы
 * второй правдой).
 *
 * Порядок проверок — от дешёвого к дорогому, до всякой печи:
 *  1. сеть адреса (`limits.craftMeshIp`, ступенями IPv6) — до базы. ⭐ R10-04: платят только НЕЗНАКОМЫЕ токены (процесс не видел их
 *     живой сессии) — и получают токен назад, если сессия жива: сеть адреса платят неудачи. Знакомый токен её не спрашивает вовсе:
 *     поток чужих токенов за общим NAT (оператор, общежитие) иначе держал бы её пустой, и соседи видели бы процедурку вместо моделей;
 *  2. сессия (`sessionUser`: нет токена или сессии — 401; потолок АККАУНТА `limits.craftMesh` — знакомый токен платит до базы);
 *  3. вид: одна строка, каноническая подпись (`parseLook`), годен конфигу (`checkLook`) — иначе 400 с причиной;
 *  4. ключ и ETag (штамп кода + ревизия таблиц модели + подпись) — совпал `If-None-Match` — 304 без печи;
 *  5. память → диск → печь (поток `worker.ts`, очередь с потолком): занято или печь упала — 503 с `Retry-After`;
 *     вид не строится — 422 (ключ помнится, повтор печь не занимает).
 * `Cache-Control: private, no-cache` — клиент держит файл и сверяет его ETag'ом (ответ 304 дешёв); правка таблицы модели в
 * редакторе меняет ETag. Ревизия таблиц — заголовком `X-Craft-Mesh-Rev` (ключ кэша клиента, если он кэширует сам).
 */
export const CRAFT_MESH_PATH = '/api/craft-mesh.glb';
export const CRAFT_MESH_REV_HEADER = 'x-craft-mesh-rev';
/** Откуда ответ: `memory` / `disk` / `bake` — для живой проверки и стенда. */
export const CRAFT_MESH_SOURCE_HEADER = 'x-craft-mesh-source';

/** Совпал ли `If-None-Match` (список, слабая форма `W/`, `*`) с ETag ответа. */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const list = (Array.isArray(header) ? header.join(',') : header).split(',').map((s) => s.trim().replace(/^W\//, ''));
  return list.some((t) => t === '*' || t === etag);
}

const tooMany = (res: import('express').Response, retrySec: number): void => {
  res.setHeader('Retry-After', String(Math.max(1, retrySec)));
  res.status(429).json({ error: 'Слишком часто. Попробуйте позже' });
};

/**
 * Поставить ручку. `service` — снаружи (тест: шпион печи, свой штамп); нет — своя: память + диск из `DM_CRAFT_MESH_CACHE_DIR`
 * (необязателен). Возвращает службу — её `close()` гасит печь.
 */
export function installCraftMeshRoute(app: Express, o: { config: ConfigRegistry; service?: CraftMeshService }): CraftMeshService {
  const svc = o.service ?? new CraftMeshService({
    config: o.config,
    cache: new GlbCache({ dir: process.env.DM_CRAFT_MESH_CACHE_DIR || undefined }),
  });
  app.get(CRAFT_MESH_PATH, ah(async (req, res) => {
    const token = bearer(req);
    const net = ipBucket(clientIp(req.headers, req.socket.remoteAddress));
    const paid = !knownSession(token);
    if (paid && !limits.craftMeshIp.take(net)) return tooMany(res, limits.craftMeshIp.retryAfterSec(net));
    if (!await sessionUser(req, res, token, limits.craftMesh)) return;
    if (paid) limits.craftMeshIp.refund(net);   // сессия жива — сеть адреса платят только неудачи
    const parsed = parseLook(queryText(req.query.look));
    if (!parsed.ok) return res.status(400).json({ error: parsed.reason });
    const check = checkLook(svc.config, parsed.hand);
    if (!check.ok) return res.status(400).json({ error: check.reason });
    const q = svc.request(parsed.sig, check.weaponClass, check.hands, parsed.hand.parts);
    if (etagMatches(req.headers['if-none-match'], q.etag)) {
      res.setHeader('ETag', q.etag);
      res.setHeader('Cache-Control', 'private, no-cache');
      res.setHeader(CRAFT_MESH_REV_HEADER, q.rev);
      return res.status(304).end();
    }
    const a = await svc.get(q);
    if (!a.ok) {
      if (a.status === 503) res.setHeader('Retry-After', '2');
      return res.status(a.status).json({ error: a.reason });
    }
    res.setHeader('ETag', q.etag);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader(CRAFT_MESH_REV_HEADER, q.rev);
    res.setHeader(CRAFT_MESH_SOURCE_HEADER, a.source);
    res.type('model/gltf-binary');
    res.send(Buffer.from(a.glb.buffer, a.glb.byteOffset, a.glb.byteLength));
  }));
  return svc;
}
