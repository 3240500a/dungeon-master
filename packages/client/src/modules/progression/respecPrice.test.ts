import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ⭐ R5-15: СБРОСЫ УХОДЯТ С ЦЕНОЙ, КОТОРУЮ ПОКАЗАЛА КНОПКА. «Сбросить атрибуты (500 золота)», «…комиссия N зол.» у дерева
 * скилов и дерева мастерств считают цену по конфигу КЛИЕНТА, а берёт сервер по своему — после деплоя с правкой баланса
 * (переподключение без перезагрузки) или правки из редактора он брал больше показанного. Команда несёт `maxGold` — дороже
 * сервер не возьмёт (`priceRaised`, отказ строкой в лог игры). Панели — DOM без стенда в node, поэтому сторож по исходнику
 * (как `render3d/online3dNet.test.ts`); само правило ядра — `shared/economy/priceConsent.test.ts`.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const src = (rel: string): string => readFileSync(join(HERE, rel), 'utf8');

describe('⭐ R5-15: кнопки сброса шлют показанную цену', () => {
  it('атрибуты — `respecCost` кнопки; скилы и мастерства — `fee` из подписи и вопроса', () => {
    // R6-11: кнопка атрибутов переехала в `respecAttrs.ts` и ждёт ответа (`request`), но цену несёт та же.
    expect(src('respecAttrs.ts'), 'было: { cmd: \'respec\' } без цены').toMatch(/app\.request\(\{ cmd: 'respec', maxGold: cost \}\)/);
    expect(src('../skills/skillTreeView.ts')).toMatch(/app\.sendCmd\(\{ cmd: 'respecSkills', maxGold: fee \}\)/);
    expect(src('../skills-passive/treeView.ts')).toMatch(/app\.sendCmd\(\{ cmd: 'respecPassives', maxGold: fee \}\)/);
  });
});
