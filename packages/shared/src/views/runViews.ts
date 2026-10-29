/**
 * ⭐⭐ С-views (29.10): ВИДЫ ОКОН ЗАБЕГА — чистые функции, которые зовёт СЕРВЕР, а Unity только рисует результат.
 *
 * Каждая функция возвращает простой JSON, чьи ключи — ровно публичные поля C#-моделей Unity (`JToken.ToObject<T>()` без настроек):
 *  • `runPortalView`      → `AltarModel`        (окно «Портал» города; было `Altar.Model` + `Altar.ChainMap`);
 *  • `runSegmentView`     → `SegmentModelView`  (алтарь отрезка на метке; было `Altar.SegmentModel`);
 *  • `runReforgeView`     → `ReforgeModelView`  (вкладка «🔮 Печати» кузницы; было `SealReforge.Model`);
 *    `runReforgeTake`     — какие печати сжечь под карточку (было `SealReforgeView.Take` НА КЛИЕНТЕ);
 *  • `runMapPanelView`    → `RunMapView`        (карта забега; было `RunMapLayout.Build`);
 *  • `runVoteQuestion`    → строка вопроса      (было `VoteText.Question`);
 *  • `runDeathFrame`      → `DeathView` + `DeathDock` + `opens` (было `DeathWindow.OnFrame/View/Dock`);
 *  • `runSpectateFrame/Tab/Hint` — наблюдение после смерти (выбор показа, см. файл).
 *
 * ⚠ Индекс пакета (`shared/src/index.ts`) эти функции пока НЕ реэкспортирует — их берут из `@dm/shared/views/runViews.js`.
 */
export * from './runCommon.js';
export * from './runPortal.js';
export * from './runSegment.js';
export * from './runReforge.js';
export * from './runMap.js';
export * from './runVote.js';
export * from './runDeath.js';
export * from './runSpectate.js';
