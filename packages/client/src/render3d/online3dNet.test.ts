import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ⭐ L2: ПРОВОДКА ВЕБ-3D К СЕТИ — ВХОД, ПОТЕРЯ СВЯЗИ И ТЕМП ВВОДА — ОБЩИМИ С 2D МОДУЛЯМИ.
 *
 * `online3d` в node не собирается (рендерер, WebGL, Jolt), поэтому его проводка стережётся по исходнику, как остальные
 * швы (`corpseCollapse.test.ts`, `clipOnly.test.ts`). Поведение самих модулей проверено на поддельном сокете:
 * `net/entryFlow.test.ts` (вход, 4009/4001/4008, два окна, мёртвое лобби), `net/inputSampler.test.ts` (темп и фронты),
 * `net/netClient.test.ts` (живой только последний сокет).
 *
 * Было: на ЛЮБОЕ закрытие сокета — лобби «Сервер недоступен» без переподключения, кнопки лобби слали `join` в мёртвый
 * сокет (после 4009 / 4001 / 4008 — только перезагрузка); ввод — свой счётчик, обнулявшийся на отправке, и фронт
 * нажатия только в кадр отправки.
 */
const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'online3d.ts'), 'utf8');

describe('⭐ L2: веб-3D — вход и потеря связи через общий поток', () => {
  it('жизнь сокета и экраны входа — у `EntryFlow` с общими экранами, своих обработчиков закрытия нет', () => {
    expect(SRC).toMatch(/new EntryFlow\(\{/);
    expect(SRC).toMatch(/view: entryScreens\(\(\) => root,/);
    expect(SRC, 'связь потеряна — мир прошлой сессии сносится').toMatch(/onLost: dropSession,/);
    expect(SRC, 'ждущие ответа команды отпускаются сразу').toMatch(/replies: app\.replies,/);
    expect(SRC, '⚠ свой обработчик закрытия вернулся').not.toMatch(/app\.net\.onClose\(/);
    expect(SRC, '⚠ свой обработчик открытия вернулся').not.toMatch(/app\.net\.onOpen\(/);
    expect(SRC, '⚠ «Сервер недоступен» на любое закрытие вернулся').not.toMatch(/['"`]Сервер недоступен/);
    expect(SRC, '⚠ свой разбор статуса забега вернулся').not.toMatch(/app\.net\.on\('runStatus'/);
    expect(SRC, '⚠ join мимо потока (в мёртвый сокет)').not.toMatch(/t: 'join'/);
    // Порядок: сперва вход в аккаунт и выбор героя, потом поток.
    const auth = SRC.indexOf('await runAuthFlow(app, root)');
    expect(auth).toBeGreaterThan(0);
    // R4-22: `entry.start()` есть и в `onRejected` (снова вход после экрана героя) — порядок сторожим у основного старта.
    expect(SRC).toMatch(/await runAuthFlow\(app, root\);[^\n]*\n\s*entry\.attach\(\);\s*entry\.start\(\);/);
  });

  it('потеря связи сносит всё, что рисовалось из прошлой сессии', () => {
    const body = SRC.slice(SRC.indexOf('function dropSession(): void {'), SRC.indexOf('const entry = new EntryFlow'));
    // R13-05: окно смерти сносит `deathWin.reset()` — закрывает оверлей и забывает смерть прошлой сессии.
    for (const must of ['closeVote(); deathWin.reset();', 'ui.closeAll();', 'spectateId = null', 'clearActors();', 'peerStatics.clear();', 'interp.drop(k)', "myId = '';"]) {
      expect(body, `dropSession: ${must}`).toContain(must);
    }
    // И смена области, и потеря связи сносят сущности ОДНОЙ функцией.
    expect(SRC).toMatch(/function buildArea\(floor: FloorInit\): void \{[\s\S]{0,400}clearActors\(\);/);
  });

  it('ввод — общий сэмплер: каждый кадр, с переносом остатка периода; своего счётчика с обнулением нет', () => {
    expect(SRC).toMatch(/const inputSampler = new InputSampler\(\);/);
    expect(SRC).toMatch(/^\s*pumpInput\(dt\);/m);
    expect(SRC, '⚠ счётчик периода с обнулением вернулся').not.toMatch(/inputAcc\s*=\s*0/);
    expect(SRC).not.toMatch(/INPUT_PERIOD/);
    expect(SRC, '⚠ своя фронт-детекция вернулась').not.toMatch(/const wasHeld/);
  });
});

describe('веб-3D: кадры, которые принимает сам App', () => {
  it('⭐ R4-37: кадр `shop` — только у App (со своими ценами сервера); своя копия брала сток без цен', () => {
    expect(SRC, '⚠ свой обработчик кадра shop вернулся').not.toMatch(/app\.net\.on\('shop'/);
  });

  it('⭐ R5-15: каждый вход сверяет конфиг с сервером (деплой не перезагружает вкладку)', () => {
    expect(SRC, 'было: конфиг — один раз на страницу').toMatch(/onJoined: \(\) => void app\.syncConfig\(\),/);
  });

  it('⭐ R6-25: «герой в мире» ведёт поток входа — вне мира хоткеи окон (I/K/C/J/M) молчат, смена закрывает окна', () => {
    expect(SRC, 'было: хоткеи окон жили под плашкой, лобби и на входе в аккаунт').toMatch(/inWorld: \(on\) => app\.setInWorld\(on\),/);
  });

  it('R4-13: адрес ноды поток спрашивает у гейтвея; R4-22: «вход недействителен» — снова вход / выбор героя', () => {
    expect(SRC).toMatch(/route: routeToNode,/);
    expect(SRC).toMatch(/onRejected: \(code\) => \{[\s\S]{0,200}runAuthFlow\(app, root\)\.then\(\(\) => entry\.start\(\)\)/);
  });
});

describe('⭐ R5-17: другой герой после R4-22 — своя кукла', () => {
  it('кукла героя собирается под героя и класс: другой (новый вход после «герой недоступен») — старая снесена вместе со светом', () => {
    const body = SRC.slice(SRC.indexOf('function buildArea(floor: FloorInit): void {'), SRC.indexOf('// Пояс (слева-внизу)'));
    expect(body, 'было: `if (!self)` — кукла прежнего героя (класс, тело, походка) навсегда').toMatch(/if \(self && selfKey !== key\) dropSelf\(\);/);
    expect(body).toMatch(/selfKey = key;/);
    const drop = SRC.slice(SRC.indexOf('function dropSelf(): void {'));
    expect(drop.slice(0, 600)).toMatch(/disposeActor\(self\)/);
    expect(drop.slice(0, 600), 'свет героя — тоже: иначе на каждого нового героя ещё одна лампа').toMatch(/scene\.remove\(playerLight\)/);
    expect(drop.slice(0, 600)).toMatch(/self = undefined/);
  });
});
