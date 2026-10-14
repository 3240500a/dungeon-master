/**
 * ⭐ 12.10 (Ф2 «Слоты и полосы», план декора): подписи формы биома → «Оформление» → правила пропов (`biomes[].dressing.props`, схема
 * `biomeDressingSchema.props`, расстановка `shared/dungeon/slots.ts`). `DECOR_FIELD_LABELS` — по имени ключа (только имена, которых нет больше
 * нигде в схемах конфигов), `DECOR_PATH_LABELS` — по пути «родитель.ключ» для общих имён (`on`, `chance`, `step`, `min`/`max`, `width`, `center`,
 * `doorway`). Сторож — `decorLabels.test.ts` (каждый путь есть в схеме, имена ключей уникальны). Подключает `main.ts`.
 */
export const DECOR_FIELD_LABELS: Record<string, string> = {
  props: 'Расстановка пропов по слотам (паспорта Unity)',
  density: 'плотность: пропов на комнату',
  perArea: 'на столько клеток пола',
  emptyRoomShare: 'доля почти пустых комнат',
  sameNotNear: 'тот же проп не ближе, клеток',
  lanes: 'полосы прохода (между проёмами и якорями)',
  minFoot: 'след пропа от, клеток',
  againstWall: 'спиной к стене',
  corner: 'угол (шаблон 2 × 2)',
  pair: 'шанс второго по другой стене',
  wall: 'грань стены (настенные)',
  corridors: 'и в коридорах',
  // ⭐ 13.10 (Ф4 «Наборы»): наборы-сценки (префабы Unity) — правила биома
  setIds: 'какие наборы (пусто — все наборы биома)',
  setLimits: 'вес и лимиты набора поверх строки Unity',
};

export const DECOR_PATH_LABELS: Record<string, string> = {
  'props.center': 'центр большой комнаты (как костёр)',
  'props.doorway': 'арки в проёмы (ширина = ширине проёма)',
  'density.min': 'от', 'density.max': 'до',
  'lanes.width': 'ширина, клеток',
  'center.on': 'вкл', 'againstWall.on': 'вкл', 'corner.on': 'вкл', 'doorway.on': 'вкл', 'wall.on': 'вкл',
  'center.chance': 'шанс на подходящую комнату', 'corner.chance': 'шанс на угол', 'doorway.chance': 'шанс на проём', 'wall.chance': 'шанс на позицию',
  'center.minRoom': 'меньшая сторона комнаты от',
  'doorway.clearBeyond': 'без чужой комнаты за проёмом (тень арки), клеток',   // ⭐ 12.10 (ревью Ф2)
  'againstWall.step': 'шаг центров по стене, граней', 'wall.step': 'шаг позиций, граней',
  // ⭐ 13.10 (Ф4 «Наборы»)
  'props.sets': 'наборы-сценки (префабы Unity: стол со стульями, полка с книгами, штабель…)',
  'sets.on': 'вкл', 'sets.chance': 'шанс, что комната пробует набор', 'sets.perRoom': 'наборов на комнату до',
  'sets.statueChance': 'шанс набора у статуи (на каждую статую, сверх плотности)',   // ⭐ 14.10 (у статуи)
  'setLimits.id': 'набор', 'setLimits.weight': 'вес', 'setLimits.perRoomMax': 'в комнате до', 'setLimits.perFloorMax': 'на этаже до',
};

/**
 * ⭐ 13.10 (Ф4 «Наборы»): подписи блока набора в строке манифеста арта (`art[].set`, только смотреть — пишет Unity). По имени — только имена,
 * которых больше нигде нет (`set`, `members`) или с тем же смыслом в правилах наборов биома (`perRoomMax`, `perFloorMax`); общие (`x`, `groups`,
 * `key`…) — как есть: подпись по имени легла бы на чужие конфиги. Подключает `main.ts`.
 */
export const SET_ART_LABELS: Record<string, string> = {
  set: 'Набор-сценка (Unity: префаб Env/<биом>/sets/<id>/)',
  members: 'члены набора (рамка набора: x вдоль, z — лицом; м, град)',
  perRoomMax: 'в комнате до',
  perFloorMax: 'на этаже до',
};
