/**
 * ⭐ ВИДЫ ГОРОДА, КУЗНИЦЫ И ВЕЩИ — то, что сервер шлёт окнам Unity готовым (клиент только рисует). Каждый вид — чистая функция
 * `(конфиг, сейв, сундук, выбор окна) → JSON` с ключами ровно публичных полей C#-моделей окна; все цены и согласия — теми же функциями
 * @dm/shared, которыми сервер исполняет команду (цена = факт). Сводка — README в отчёте интеграции; тесты — town*.test.ts по эталонам Unity.
 */
export * from './townMaterials.js';
export * from './townSalvage.js';
export * from './townItem.js';
export * from './townBench.js';
export * from './townExchange.js';
export * from './townShop.js';
export * from './townHero.js';
