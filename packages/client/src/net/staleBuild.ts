/**
 * ⭐ R10-12: КОД ВКЛАДКИ СТАРШЕ СЕРВЕРА — ЛЕНИВЫЙ КУСОК СБОРКИ НЕ ЗАГРУЗИЛСЯ.
 *
 * Сборка режет клиент на куски с хэшем в имени, и тяжёлые грузятся динамическим `import()` при первой нужде (окно ковки
 * и модель оружия из деталей — `forgeCraftTab-<хэш>.js`). Деплой (`npm run build`) очищает `dist` и меняет хэши, а
 * вкладка с L2 его переживает без перезагрузки (переподключается сама) при прежнем `PROTOCOL_VERSION`: первый же
 * `import()` просит файл, которого больше нет. Раньше окно ковки писало «Нет связи… переключи вкладку» и каждый повтор
 * падал снова, а оружие из деталей — своё и чужое — молча оставалось процедурным на всю сессию; про F5 не говорил никто.
 *
 * Упавший `import()` — повод ПЕРЕЗАГРУЗИТЬ страницу, а не ждать: вкладке нужен новый код, а браузер может помнить
 * неудачную загрузку модуля до перезагрузки документа, так что и при мигнувшей связи повтор того же куска не обязан
 * помочь. Кто поймал сбой — зовёт `markStaleBuild`; игрок слышит об этом ОДИН раз на страницу (`App` — строкой
 * `PROTOCOL_STALE` в лог игры), окно ковки показывает кнопку перезагрузки. Сбой, который никто не поймал, ловит
 * `watchChunkErrors`: обёртка Vite вокруг каждого ленивого `import()` сборки шлёт на `window` событие `vite:preloadError`.
 *
 * ⭐ R18-08: кусок грузится, а код в нём — старый: деплой сменил формулу цены при том же теле конфига. Это видно по ШТАМПУ сборки
 * (`clientBuild` — вписан `vite build`, `joined.build` — у сервера): не сошлись (`buildDiffers`) — `App` говорит «перезагрузите» на входе и
 * на каждый отказ «Цена изменилась», который перечитывание конфига не лечит.
 */

let stale = false;
const subs = new Set<() => void>();
const watched = new WeakSet<object>();

/** Кусок кода не загрузился (`where` — что именно): вкладка устарела — сказать игроку один раз на страницу. */
export function markStaleBuild(where: string, err?: unknown): void {
  if (stale) return;
  stale = true;
  console.warn(`[build] ${where}: кусок кода не загрузился — вкладка старше сервера (деплой) или нет связи; нужна перезагрузка страницы`, err);
  for (const cb of [...subs]) cb();
}

/** Страница уже знает, что её код устарел. */
export function isStaleBuild(): boolean { return stale; }

/** Подписка «код устарел» (`App` — строкой в лог игры); страница уже устарела — зовётся сразу. Возвращает отписку. */
export function onStaleBuild(cb: () => void): () => void {
  subs.add(cb);
  if (stale) cb();
  return () => { subs.delete(cb); };
}

/**
 * Слушать `vite:preloadError` (один раз на цель). Событие не гасим (`preventDefault` не зовём): `import()` отказывает
 * своему вызывающему как прежде, и тот показывает своё (окно ковки — кнопку перезагрузки). В разработке (`vite` без
 * сборки) события нет — там сбой ловят сами вызывающие.
 */
export function watchChunkErrors(target: Pick<EventTarget, 'addEventListener'> | undefined = typeof window === 'undefined' ? undefined : window): void {
  if (!target || watched.has(target)) return;
  watched.add(target);
  target.addEventListener('vite:preloadError', (e) => markStaleBuild('ленивый кусок сборки', (e as Event & { payload?: unknown }).payload));
}

/** Перезагрузить страницу — новый код с сервера (кнопка окна, которому не хватило куска). */
export function reloadPage(): void { location.reload(); }

/**
 * ⭐ R18-08: штамп сборки вкладки — хэш исходников shared (`buildStampOf`), вписанный `vite build` (`client/vite.config.ts`). Дев-сервер Vite
 * вписывает пустой (исходники там меняются под открытой вкладкой, а штамп считается раз на запуск), без сборки — поля нет вовсе (тесты, мост
 * редактора): сравнивать нечего.
 */
declare const __DM_BUILD__: string | undefined;
export function clientBuild(): string { return typeof __DM_BUILD__ === 'string' ? __DM_BUILD__ : ''; }

/**
 * ⭐ R18-08: код вкладки не той сборки, что у сервера (`joined.build`): деплой сменил код цен, а вкладка его пережила без перезагрузки. Нет
 * штампа с любой стороны (сервер старше штампа, вкладка из дев-сервера) — не знаем, не говорим.
 */
export function buildDiffers(server: string | undefined): boolean {
  const mine = clientBuild();
  return !!server && !!mine && server !== mine;
}
