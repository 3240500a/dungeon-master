import { describe, it, expect } from 'vitest';
import {
  CLIENT_BUILD_MAX, URLS, badgesOf, buildModel, describeChange, errorText, fmtTime, loadList, parseBuildInput, parseChange, parseList,
  parsePercentInput, planClients, planPromote, planRollback, rolloutText, runPlan, short,
  type ChannelChange, type ListedChannel, type Plan, type Release, type ReleaseList, type Send,
} from './releasesModel.js';

/**
 * ⭐ 08.10 (Д3): вкладка «📦 Выпуски» — чистая часть. Главное здесь — ПЛАН действия: подтверждение обязано говорить правду про этот случай
 * (первый выпуск, подъём процента, новое содержимое, перевыпуск, откат), а заведомый отказ сервера — не доходить до окна подтверждения.
 * Совпадение плана с настоящим сервером — `releasesServer.test.ts`.
 */

const M = (c: string): string => c.repeat(64).slice(0, 64);
const rel = (seq: number, manifest: string, extra: Partial<Release> = {}): Release => ({
  seq, abi: 1, manifest, manifestSize: 2048, configRev: 'cfg-rev-0001', gameRev: 'game-rev-01', created: Date.UTC(2026, 9, 8, 10, seq),
  note: '', origin: null, channels: [], ...extra,
});
const chan = (channel: string, seq: number, extra: Partial<ListedChannel> = {}): ListedChannel => ({
  channel, abi: 1, seq, prev: null, rollout: 100, minClient: 0, latestClient: 0, updated: Date.UTC(2026, 9, 8, 12), updatedBy: 'cutter',
  auto: channel === 'dev', ...extra,
});
const list = (releases: Release[], channels: ListedChannel[], extra: Partial<ReleaseList> = {}): ReleaseList => ({
  abi: 1, keyId: '0123456789abcdef', devKey: true, devFallback: true, releases, channels, ...extra,
});
const okPlan = (p: Plan): Extract<Plan, { ok: true }> => { if (!p.ok) throw new Error(`ожидался план, а не отказ: ${p.error}`); return p; };
const noPlan = (p: Plan): Extract<Plan, { ok: false }> => { if (p.ok) throw new Error(`ожидался отказ, а не план: ${p.confirm}`); return p; };

/** dev на #5, beta на #3, live на #2 (прежний #1); #4 — новое содержимое; #6 — перевыпуск содержимого #2. */
const base = (): ReleaseList => list(
  [rel(1, M('a')), rel(2, M('b')), rel(3, M('c')), rel(4, M('d')), rel(5, M('e')), rel(6, M('b'), { origin: 2 })],
  [chan('dev', 5, { prev: 4 }), chan('beta', 3, { updatedBy: 'key' }), chan('live', 2, { prev: 1, updatedBy: 'u-1' })],
);

describe('разбор ответов сервера', () => {
  it('список по форме — принимается; лишние поля (новые на сервере) не мешают', () => {
    const body = { ...base(), extra: 1, releases: base().releases.map((r) => ({ ...r, newField: true })) };
    const p = parseList({ status: 200, body });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.value.releases).toHaveLength(6);
  });

  it('200, но не по форме (старый сервер отдал страницу игры вместо JSON) — понятный отказ, а не падение вкладки', () => {
    const p = parseList({ status: 200, body: undefined });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error).toMatch(/не по форме/);
    const q = parseChange({ status: 200, body: { channel: 'live' } }, 'Выпуск в live');
    expect(!q.ok && q.error).toMatch(/^Выпуск в live: ответ сервера не по форме \(abi\)/);
  });

  it('ошибки — текстом для человека: сеть, вход, роль, старый сервер, отказ правилом, недостающие файлы, 500', () => {
    expect(errorText({ status: 0, body: undefined }, 'Список')).toMatch(/сервер не отвечает/);
    expect(errorText({ status: 401, body: { error: 'Требуется вход' } }, 'Список')).toMatch(/нужен вход администратора/);
    expect(errorText({ status: 403, body: { error: 'Нужны права администратора' } }, 'Список')).toMatch(/нет прав администратора.*роли admin/);
    expect(errorText({ status: 404, body: undefined }, 'Список')).toMatch(/не знает ручек выпуска.*до Д3/);
    expect(errorText({ status: 404, body: { error: 'релиза #9 нет' } }, 'Выпуск в live')).toBe('Выпуск в live: сервер отказал (404) — релиза #9 нет.');
    const miss = errorText({ status: 409, body: { error: 'у релиза #4 нет файлов в хранилище (5) — выпускать нечего', missing: [M('1'), M('2'), M('3'), M('4'), M('5')], count: 5 } }, 'В бету');
    expect(miss).toContain('сервер отказал (409) — у релиза #4 нет файлов');
    expect(miss).toContain(`Нет в хранилище: ${short(M('1'))}, ${short(M('2'))}, ${short(M('3'))} и ещё 2`);
    expect(errorText({ status: 500, body: { error: 'boom' } }, 'Откат live')).toMatch(/ошибка сервера \(500\) — boom.*\[dm-server\] \[content\]/);
    expect(errorText({ status: 418, body: 'teapot' }, 'X')).toBe('X: неожиданный ответ сервера (418).');
  });
});

describe('модель страницы', () => {
  it('каналы — всегда dev, beta, live по порядку; не выпущенный — без состояния; текущий и прежний — из списка', () => {
    const m = buildModel(list([rel(1, M('a')), rel(2, M('b'))], [chan('dev', 2, { prev: 1 })]));
    expect(m.channels.map((c) => c.name)).toEqual(['dev', 'beta', 'live']);
    expect(m.channels.map((c) => c.state?.seq ?? null)).toEqual([2, null, null]);
    expect(m.channels[0]!.auto).toBe(true);
    expect(m.channels[0]!.current?.seq).toBe(2);
    expect(m.channels[0]!.previous?.seq).toBe(1);
    expect(m.releases.map((r) => r.seq)).toEqual([2, 1]);
    expect(m.maxSeq).toBe(2);
  });

  it('ABI: вкладка показывает выбранную, список ABI — из релизов, каналов и сервера', () => {
    const l = list([rel(1, M('a')), rel(2, M('b'), { abi: 2 })], [chan('dev', 1), chan('dev', 2, { abi: 2 })]);
    const m1 = buildModel(l);
    expect(m1.abis).toEqual([1, 2]);
    expect(m1.releases.map((r) => r.seq)).toEqual([1]);
    const m2 = buildModel(l, 2);
    expect(m2.releases.map((r) => r.seq)).toEqual([2]);
    expect(m2.channels[0]!.state?.seq).toBe(2);
    expect(m2.maxSeq).toBe(2);
  });

  it('метки каналов у релиза: целиком, по проценту, прежний с долей, цель отката (у dev — «прежний»: кнопки нет); порядок dev → beta → live', () => {
    const r = rel(7, M('x'), { channels: [
      { channel: 'live', as: 'prev', percent: 90 }, { channel: 'beta', as: 'current', percent: 100 }, { channel: 'dev', as: 'prev', percent: 0 },
    ] });
    expect(badgesOf(r).map((b) => b.text)).toEqual(['dev · прежний', 'beta', 'live · прежний 90%']);
    expect(badgesOf(rel(9, M('z'), { channels: [{ channel: 'beta', as: 'prev', percent: 0 }] })).map((b) => b.text)).toEqual(['beta · цель отката']);
    expect(badgesOf(rel(8, M('y'), { channels: [{ channel: 'live', as: 'current', percent: 10 }] }))).toEqual([{ text: 'live 10%', kind: 'rollout' }]);
  });

  it('раскатка словами', () => {
    const m = buildModel(list([rel(1, M('a')), rel(2, M('b'))], [chan('live', 2, { prev: 1, rollout: 10 })]));
    expect(rolloutText(m.channels[2]!)).toBe('10% на #2, 90% на #1');
    expect(rolloutText(m.channels[1]!)).toBe('—');
  });

  it('дата — «дд.мм.гггг чч:мм»', () => {
    expect(fmtTime(Date.UTC(2026, 9, 8, 12, 5))).toMatch(/^\d{2}\.10\.2026 \d{2}:\d{2}$/);
  });
});

describe('план «В бету» / «Выпустить»', () => {
  it('dev и чужой канал — отказ сразу; процент вне 1..100 и неизвестный релиз — тоже', () => {
    const m = buildModel(base());
    expect(noPlan(planPromote(m, 'dev', 5, 100)).error).toMatch(/dev меняется сам/);
    expect(noPlan(planPromote(m, 'prod', 5, 100)).error).toMatch(/beta, live/);
    for (const p of [0, 101, NaN, 5.5]) expect(planPromote(m, 'live', 4, p).ok).toBe(false);
    expect(noPlan(planPromote(m, 'live', 99, 100)).error).toMatch(/#99 нет в списке/);
  });

  it('первый выпуск канала — только на 100%; подтверждение говорит «впервые»; live без беты — предупреждение', () => {
    const m = buildModel(list([rel(1, M('a'))], [chan('dev', 1)]));
    expect(noPlan(planPromote(m, 'live', 1, 10)).error).toMatch(/первый выпуск только на 100%/);
    const p = okPlan(planPromote(m, 'live', 1, 100));
    expect(p.url).toBe(URLS.promote);
    expect(p.body).toEqual({ channel: 'live', seq: 1, percent: 100 });
    expect(p.confirm).toMatch(/выпускается впервые/);
    expect(p.confirm).toMatch(/beta ещё не выпущен/);
    expect(p.expect).toEqual({ seq: 1, rollout: 100, prev: null, reissued: false, origin: 1 });
    expect(okPlan(planPromote(m, 'beta', 1, 100)).confirm).not.toMatch(/⚠/);
  });

  it('новое содержимое на 100% — текущий станет прежним; на 10% — остальные остаются на текущем', () => {
    const m = buildModel(base());
    const all = okPlan(planPromote(m, 'live', 4, 100));
    expect(all.expect).toEqual({ seq: 4, rollout: 100, prev: 2, reissued: false, origin: 4 });
    expect(all.confirm).toMatch(/для всех \(100%\)/);
    expect(all.confirm).toMatch(/#2 станет прежним/);
    const part = okPlan(planPromote(m, 'live', 4, 10));
    expect(part.expect).toMatchObject({ seq: 4, rollout: 10, prev: 2 });
    expect(part.confirm).toMatch(/~10% устройств.*~90% остаются на #2/);
    expect(part.confirm).toMatch(/В beta сейчас другое содержимое \(#3\)/);
  });

  it('⭐ релиз не новее текущего — перевыпуск под новым номером (номер канала только растёт)', () => {
    const m = buildModel(base());
    const p = okPlan(planPromote(m, 'beta', 1, 100));
    expect(p.expect).toEqual({ seq: 'new', rollout: 100, prev: 3, reissued: true, origin: 1 });
    expect(p.confirm).toMatch(/#1 не новее текущего #3 — сервер перевыпустит.*больше #6/);
  });

  it('то же содержимое — только процент и только вверх; равный — «так уже есть», без запроса', () => {
    const l = base();
    l.channels[2] = chan('live', 4, { prev: 2, rollout: 10 });
    const m = buildModel(l);
    expect(noPlan(planPromote(m, 'live', 4, 5)).error).toMatch(/только растёт \(10% → 5%\)/);
    const same = noPlan(planPromote(m, 'live', 4, 10));
    expect(same.noop).toBe(true);
    const up = okPlan(planPromote(m, 'live', 4, 50));
    expect(up.expect).toEqual({ seq: 4, rollout: 50, prev: 2, reissued: false, origin: 4 });
    expect(up.confirm).toMatch(/Поднять раскатку #4 в live: 10% → 50%/);
    expect(up.confirm).toMatch(/~50% устройств \(было ~10%\), остальные ~50% остаются на #2/);
    expect(okPlan(planPromote(m, 'live', 4, 100)).confirm).toMatch(/все клиенты live получат #4\. #2 останется прежним/);
  });

  it('посреди раскатки другой релиз — отказ: доведи до 100% или откати', () => {
    const l = base();
    l.channels[2] = chan('live', 4, { prev: 2, rollout: 10 });
    expect(noPlan(planPromote(buildModel(l), 'live', 5, 100)).error).toMatch(/идёт раскатка #4 \(10%\)/);
  });

  it('перевыпуск того же содержимого (другой номер, тот же манифест) — для канала это то же содержимое', () => {
    const l = base();
    l.channels[2] = chan('live', 6, { prev: 4, rollout: 20 });
    const m = buildModel(l);
    const p = okPlan(planPromote(m, 'live', 2, 60));
    expect(p.expect).toEqual({ seq: 6, rollout: 60, prev: 4, reissued: false, origin: 2 });
    expect(p.confirm).toMatch(/#2 несёт то же содержимое, что #6/);
  });
});

describe('план «Откатить»', () => {
  it('не выпущен — некуда; нет прежнего и не выбран релиз — подсказка «выбери в списке»', () => {
    const m = buildModel(base());
    const l = base();
    l.channels = l.channels.filter((c) => c.channel !== 'live');
    expect(noPlan(planRollback(buildModel(l), 'live')).error).toMatch(/не выпущен/);
    expect(noPlan(planRollback(m, 'beta')).error).toMatch(/нет прежнего релиза.*Откатить к выбранному/);
    expect(noPlan(planRollback(m, 'dev')).error).toMatch(/dev меняется сам/);
  });

  it('к прежнему — перевыпуск под новым номером, 100%, без прежнего; тело без toSeq', () => {
    const p = okPlan(planRollback(buildModel(base()), 'live'));
    expect(p.url).toBe(URLS.rollback);
    expect(p.body).toEqual({ channel: 'live', abi: 1 });
    expect(p.expect).toEqual({ seq: 'new', rollout: 100, prev: null, reissued: true, origin: 1 });
    expect(p.confirm).toMatch(/под НОВЫМ номером \(больше #6\)/);
    expect(p.confirm).toMatch(/повторный «Откатить» не вернёт #2/);
  });

  it('к выбранному: то же содержимое — отказ; содержимое новее текущего — отказ (это выпуск); перевыпуск старого — назад; раскатка снимается', () => {
    const l = base();
    l.channels[2] = chan('live', 4, { prev: 2, rollout: 30 });
    const m = buildModel(l);
    expect(noPlan(planRollback(m, 'live', 4)).error).toMatch(/уже на содержимом #4/);
    expect(noPlan(planRollback(m, 'live', 5)).error).toMatch(/откат только назад: содержимое #5 новее текущего #4/);
    const back = okPlan(planRollback(m, 'live', 6));
    expect(back.expect).toMatchObject({ seq: 6, reissued: false, origin: 2 });
    expect(back.confirm).toMatch(/Идущая раскатка снимается/);
  });
});

describe('план «Версии клиента»', () => {
  it('dev — только просмотр; кривые числа, min выше latest — отказ; так уже стоит — без запроса', () => {
    const m = buildModel(base());
    expect(noPlan(planClients(m, 'dev', '1', '1')).error).toMatch(/только просмотр/);
    expect(noPlan(planClients(m, 'live', '-1', '0')).error).toMatch(/minClient — целое/);
    expect(noPlan(planClients(m, 'live', '1', String(CLIENT_BUILD_MAX + 1))).error).toMatch(/latestClient — целое/);
    expect(noPlan(planClients(m, 'live', '7', '5')).error).toMatch(/minClient \(7\) выше latestClient \(5\)/);
    expect(noPlan(planClients(m, 'live', '0', '')).noop).toBe(true);
  });

  it('подтверждение называет оба последствия и предупреждает про Steam; тело — оба числа и ABI', () => {
    const p = okPlan(planClients(buildModel(base()), 'live', '5', '6'));
    expect(p.url).toBe(URLS.clients);
    expect(p.body).toEqual({ channel: 'live', abi: 1, minClient: 5, latestClient: 6 });
    expect(p.confirm).toMatch(/minClient 0 → 5: сборки ниже 5 увидят экран «Обновите игру»/);
    expect(p.confirm).toMatch(/latestClient 0 → 6: сборки ниже 6 увидят плашку «Доступно обновление»/);
    expect(p.confirm).toMatch(/Steam уже раздал сборку 5/);
    expect(p.expect).toEqual({ seq: 2, rollout: 100, prev: 1, reissued: false, origin: 2, minClient: 5, latestClient: 6 });
  });

  it('снять — «снимается», без предупреждения про Steam', () => {
    const l = base();
    l.channels[1] = chan('beta', 3, { minClient: 4, latestClient: 9 });
    const p = okPlan(planClients(buildModel(l), 'beta', '0', '0'));
    expect(p.confirm).toMatch(/экран «Обновите игру» снимается/);
    expect(p.confirm).toMatch(/плашка «Доступно обновление» снимается/);
    expect(p.confirm).not.toMatch(/Steam/);
  });
});

describe('поля ввода', () => {
  it('процент — целое 1..100', () => {
    expect(parsePercentInput(' 50 ')).toBe(50);
    for (const t of ['', '0', '101', '5.5', '1e2', 'abc', '-3']) expect(parsePercentInput(t), t).toBeNull();
  });
  it('номер сборки — целое 0..потолок; пусто — 0', () => {
    expect(parseBuildInput('')).toBe(0);
    expect(parseBuildInput(String(CLIENT_BUILD_MAX))).toBe(CLIENT_BUILD_MAX);
    for (const t of ['-1', '1.5', String(CLIENT_BUILD_MAX + 1), 'x']) expect(parseBuildInput(t), t).toBeNull();
  });
});

describe('итог действия и запрос', () => {
  const change = (over: Partial<ChannelChange> = {}): ChannelChange => ({
    channel: 'live', abi: 1, seq: 9, rollout: 10, prev: 2, minClient: 0, latestClient: 0, reissued: false, origin: 9, changed: true,
    was: { seq: 2, rollout: 100, prev: 1 }, ...over,
  });

  it('итог словами: что стало и что было; перевыпуск; «без изменений»; первый выпуск', () => {
    expect(describeChange(change())).toBe('live: #9 на 10%, прежний #2 — было #2 на 100%, прежний #1.');
    expect(describeChange(change({ seq: 10, rollout: 100, prev: null, reissued: true, origin: 2 }))).toMatch(/Номер #10 — перевыпуск содержимого #2\./);
    expect(describeChange(change({ changed: false }))).toBe('live: без изменений (#9 на 10%, прежний #2).');
    expect(describeChange(change({ was: null, prev: null, rollout: 100 }))).toBe('live: #9 на 100% — канал выпущен впервые.');
    expect(describeChange(change({ minClient: 3, latestClient: 4 }), true)).toBe('live: minClient 3, latestClient 4.');
  });

  /** Подмена `devFetch`: ответ по адресу. */
  const fake = (replies: Record<string, { status: number; body: unknown } | 'down'>, seen: { url: string; init?: RequestInit }[] = []): Send =>
    async (url, init) => {
      seen.push({ url, init });
      const r = replies[url.split('?')[0]!];
      if (!r || r === 'down') throw new TypeError('fetch failed');
      return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status });
    };

  it('список: адрес с лимитом; сервер лежит — «не отвечает»', async () => {
    const seen: { url: string }[] = [];
    const ok = await loadList(fake({ [URLS.list]: { status: 200, body: base() } }, seen), 50);
    expect(ok.ok).toBe(true);
    expect(seen[0]!.url).toBe(`${URLS.list}?limit=50`);
    const down = await loadList(fake({ [URLS.list]: 'down' }));
    expect(!down.ok && down.error).toMatch(/сервер не отвечает/);
    const html = await loadList(fake({ [URLS.list]: { status: 200, body: '<!doctype html><html>игра</html>' } }));
    expect(!html.ok && html.error).toMatch(/не по форме/);
  });

  it('действие: POST JSON с телом плана; ответ — итог словами; отказ — текст сервера', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const plan = okPlan(planPromote(buildModel(base()), 'live', 4, 10));
    const r = await runPlan(fake({ [URLS.promote]: { status: 200, body: change({ seq: 4, prev: 2 }) } }, seen), plan);
    expect(r).toMatchObject({ ok: true, text: 'live: #4 на 10%, прежний #2 — было #2 на 100%, прежний #1.' });
    expect(seen[0]!.init).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(String(seen[0]!.init!.body))).toEqual({ channel: 'live', seq: 4, percent: 10 });
    const no = await runPlan(fake({ [URLS.promote]: { status: 409, body: { error: 'в live идёт раскатка #4 (10%) — доведи её до 100% или откати' } } }), plan);
    expect(!no.ok && no.error).toBe('Выпуск в live: сервер отказал (409) — в live идёт раскатка #4 (10%) — доведи её до 100% или откати.');
  });
});
