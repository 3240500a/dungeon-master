import { describe, it, expect } from 'vitest';
import { BUILD_CHANGED, CONFIG_CONSENT_CMDS, PRICE_CHANGED, buildChanged, withConfigRev } from './townActions.js';
import { buildStampOf } from '../session/buildStamp.js';
import { parseTownCommand } from '../session/netSchemas.js';
import type { TownCommand } from '../session/netTypes.js';

/**
 * ⭐ D3: СОГЛАСИЕ НА СБОРКУ — зеркало согласия на конфиг (V-B3-07) для КОДА. Команды, чей исход и цену окно считает своим кодом (кузница, лавка,
 * разбор — `CONFIG_CONSENT_CMDS`), несут штамп сборки вкладки; сервер с другим штампом отказывает до исполнения причиной «Цена изменилась…»
 * (по ней вкладка перечитывает конфиг и говорит «перезагрузите»). Нет штампа с любой стороны — сравнивать нечего (Unity, дев-сервер Vite).
 */
describe('⭐ D3: согласие на сборку (`buildChanged`, `withConfigRev`)', () => {
  const stamp = buildStampOf([['economy/townActions.ts', 'export const P = 1;\n']]);

  it('чужой штамп — отказ причиной «Цена изменилась…»; свой, пустой с любой стороны — не отказ', () => {
    expect(buildChanged(stamp, `${stamp}-old`)).toEqual({ ok: false, reason: BUILD_CHANGED });
    expect(BUILD_CHANGED.startsWith(PRICE_CHANGED), 'клиент перечитывает конфиг по этой причине').toBe(true);
    expect(buildChanged(stamp, stamp)).toBeNull();
    expect(buildChanged(stamp, undefined), 'Unity и старые вкладки штампа не шлют').toBeNull();
    expect(buildChanged(stamp, ''), 'дев-сервер Vite — пустой штамп').toBeNull();
    expect(buildChanged('', stamp), 'сервер без исходников — сравнивать нечего').toBeNull();
  });

  it('штамп едет только у команд согласия и только непустой; схема сервера такую команду принимает', () => {
    const sell: TownCommand = { cmd: 'sell', uid: 'x', minGold: 3 };
    const withBuild = withConfigRev('abc-def', sell, stamp) as TownCommand & { build?: string };
    expect(withBuild.build).toBe(stamp);
    expect(parseTownCommand(withBuild).ok).toBe(true);
    expect('build' in withConfigRev('abc-def', sell), 'без штампа — поля нет').toBe(false);
    expect('build' in withConfigRev('abc-def', { cmd: 'buy', uid: 'x', maxGold: 3 }, stamp), 'покупка — не команда согласия').toBe(false);
    // Каждая команда согласия в схеме сервера знает поле `build` (иначе `.strict()` отвергла бы её целиком — «Неверная команда»).
    const minimal: Record<string, Record<string, unknown>> = {
      sell: { uid: 'x' }, forgeUpgrade: { uid: 'x' }, forgeReroll: { uid: 'x' }, forgeRepair: { uid: 'x' }, forgeSalvage: { uid: 'x' },
      salvage: { uid: 'x' }, forgeEnchant: { uid: 'x', rarity: 'magic' }, forgeSketch: { variantId: 'x' }, forgeExchange: { from: 'iron-1', to: 'wood', n: 3 },
      craft: { nonce: 'nonce-0001', input: { weaponClass: 'sword', hands: 1, parts: { strike: { id: 'a', step: 1 }, grip: { id: 'b', step: 1 }, bind: { id: 'c', step: 1 }, head: { id: 'd', step: 1 } } } },
    };
    expect(Object.keys(minimal).sort()).toEqual([...CONFIG_CONSENT_CMDS].sort());
    for (const cmd of CONFIG_CONSENT_CMDS) {
      const r = parseTownCommand({ cmd, ...minimal[cmd], cfgRev: 'abc-def', build: stamp });
      expect(r.ok, `${cmd}: ${r.ok ? '' : r.error}`).toBe(true);
    }
  });

  it('схема: штамп — base36-части через дефис, не длиннее 64; прочее — «Неверная команда»', () => {
    const cmd = (build: string): unknown => ({ cmd: 'sell', uid: 'x', minGold: 3, cfgRev: 'abc-def', build });
    expect(parseTownCommand(cmd(stamp)).ok).toBe(true);
    for (const bad of ['', 'A-B', 'a--b', 'a b', '-a', 'a-', 'x'.repeat(65), 'a+deploy1']) expect(parseTownCommand(cmd(bad)).ok, bad).toBe(false);
  });
});
