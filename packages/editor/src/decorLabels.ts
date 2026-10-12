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
};
