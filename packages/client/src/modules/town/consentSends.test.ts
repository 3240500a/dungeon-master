import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ⚠ R6-16: ПОКУПКА, ПРОДАЖА И УЗЕЛ МАСТЕРСТВА УХОДЯТ С ПОКАЗАННОЙ ЦЕНОЙ. Лавка и кузница показывают цену кадра `shop`, подпись
 * продажи «+N» и карточка «след. ранг: N зол.» — по конфигу клиента, а берёт и платит сервер по своему. Команда несёт то, что
 * видел игрок (`maxGold` у покупки и мастерства, `minGold` у продажи): иначе сервер молча брал больше (платил меньше) после
 * правки цен. Панели — DOM без стенда в node, поэтому сторож по исходнику (как `progression/respecPrice.test.ts`); правило
 * ядра — `shared/economy/priceConsent.test.ts`.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const src = (rel: string): string => readFileSync(join(HERE, rel), 'utf8');

describe('⚠ R6-16: команды лавки и мастерства несут показанную цену', () => {
  it('покупка в лавке и в кузнице — цена кадра (`app.shopPrice`); продажа — подпись «+N»; мастерство — цена карточки', () => {
    expect(src('shopPanel.ts')).toMatch(/app\.sendCmd\(\{ cmd: 'buy', uid: it\.uid, maxGold: app\.shopPrice\(it\) \}\)/);
    expect(src('forgePanel.ts')).toMatch(/app\.sendCmd\(\{ cmd: 'buy', uid: it\.uid, maxGold: app\.shopPrice\(it\) \}\)/);
    expect(src('shopPanel.ts')).toMatch(/app\.sendCmd\(\{ cmd: 'sell', uid: item\.uid, minGold: price \}\)/);
    expect(src('../skills-passive/treeView.ts')).toMatch(/cmd: 'allocPassive', nodeId: node\.id, maxGold: passiveNodeCost\(node\.cost\.amount, rank, mult\)/);
    // Команды без цены в этих панелях не осталось.
    expect(src('shopPanel.ts')).not.toMatch(/cmd: 'buy', uid: it\.uid \}/);
    expect(src('forgePanel.ts')).not.toMatch(/cmd: 'buy', uid: it\.uid \}/);
  });
});
