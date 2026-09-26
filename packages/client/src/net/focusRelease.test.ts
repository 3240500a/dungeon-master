import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onFocusLost } from './focusRelease.js';
import { InputSampler } from './inputSampler.js';

/**
 * ⭐ R4-20: ЗАЖАТОЕ НЕ ЗАЛИПАЕТ ПОСЛЕ ALT-TAB. `keyup`/`pointerup` при потере фокуса достаются другому окну, и клиент слал
 * «W и ЛКМ зажаты», пока их не нажмут снова: герой бежал и бил без игрока. Поведение — на поддельных окне и документе; то,
 * что оба клиента его подключили, стережётся по исходнику (веб-3D в node не собирается — см. `online3dNet.test.ts`).
 */
class FakeDoc extends EventTarget { hidden = false; }
const DIR = dirname(fileURLToPath(import.meta.url));

describe('R4-20: окно потеряло фокус — зажатое отпущено', () => {
  it('⭐ blur и скрытие вкладки отпускают; показ вкладки — нет; отписка снимает оба', () => {
    const win = new EventTarget();
    const doc = new FakeDoc();
    let released = 0;
    const off = onFocusLost(win, doc, () => { released++; });
    win.dispatchEvent(new Event('blur'));
    expect(released, 'alt-tab').toBe(1);
    doc.hidden = false;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(released, 'вкладку показали — отпускать нечего').toBe(1);
    doc.hidden = true;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(released, 'вкладку скрыли').toBe(2);
    off();
    win.dispatchEvent(new Event('blur'));
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(released, 'после отписки — тишина').toBe(2);
  });

  it('⭐ веб-3D: зажатая W и blur — следующий кадр ввода «стою» (так отпускает `online3d`)', () => {
    // Модель проводки `online3d`: клавиши — набор, отпускание — очистка и кадр «стою» сразу.
    const keys = new Set<string>(['KeyW']);
    let lmb = true;
    const sent: { move: { x: number; y: number }; attack: boolean }[] = [];
    const win = new EventTarget();
    onFocusLost(win, new FakeDoc(), () => { keys.clear(); lmb = false; sent.push({ move: { x: 0, y: 0 }, attack: false }); });
    win.dispatchEvent(new Event('blur'));
    expect(keys.size).toBe(0);
    expect(lmb).toBe(false);
    expect(sent.at(-1), 'кадр «стою» ушёл сразу').toEqual({ move: { x: 0, y: 0 }, attack: false });
    // И сэмплер после отпускания не видит зажатого — удар не уходит.
    const s = new InputSampler().frame(40, { mouseLeft: 'attack', mouseRight: null, hotbar: [] },
      { L: lmb, R: false, S: false, Q: false, A: false, dodge: false, interact: false }, () => false);
    expect(s.attack).toBe(false);
  });

  it('оба клиента отпускают зажатое при потере фокуса', () => {
    const web3d = readFileSync(join(DIR, '..', 'render3d', 'online3d.ts'), 'utf8');
    expect(web3d, 'веб-3D подключил отпускание').toMatch(/onFocusLost\(window, document, \(\) => \{[\s\S]{0,300}keys\.clear\(\);[\s\S]{0,120}lmb = false; rmb = false;[\s\S]{0,300}t: 'input'/);
    const net2d = readFileSync(join(DIR, 'netDriver.ts'), 'utf8');
    expect(net2d, '2D: кнопки мыши (клавиши Phaser отпускает сам)').toMatch(/onFocusLost\(window, document, \(\) => \{ this\.leftHeld = false; this\.rightHeld = false; \}\)/);
    expect(net2d, '2D: отписка при сносе').toMatch(/this\.offFocus\(\);/);
  });
});
