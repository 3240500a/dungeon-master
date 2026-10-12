import { describe, it, expect } from 'vitest';
import { ConfigRegistry } from '../config/registry.js';
import { artDecorSchema, type ArtDecor } from '../config/schemas.js';
import { DECOR_TALL_HEIGHT, decorWarnings, type ArtRowLite, type BiomeDecorLite, type ObjCfgLite } from './decor.js';

/**
 * ⭐ 12.10 (Ф2 «Слоты и полосы», план декора — «Как проверяем»): ПРЕДУПРЕЖДЕНИЯ РАССТАНОВКИ редактора (`decorWarnings`, «Проверить конфиг»):
 * высокий проп у ближней стены, правила без пропов, проп, который слоты молча пропускают. Живой конфиг с семенем Ф2 — чисто: ⭐ 13.10 (ревью)
 * слот граней стены крипты выключен (`dressing.props.wall.on: false` в data), пока нет настенного паспорта; включённый — то самое предупреждение.
 */
const P = (p: Partial<ArtDecor>): ArtDecor => artDecorSchema.parse(p);
const obj = (id: string, o: Partial<ObjCfgLite> = {}): ObjCfgLite =>
  ({ id, modelId: id, enabled: true, role: 'prop', surface: 'floor', biomes: ['crypt'], blocks: false, blocksSight: false, footprint: { w: 1, h: 1 }, spawnChance: 0.35, clearance: 0, ...o });
const art = (id: string, decor: Partial<ArtDecor>, top = 1, kind = 'env'): ArtRowLite =>
  ({ id, kind, group: 'biome_crypt', bounds: { min: [-0.5, 0, -0.5], max: [0.5, top, 0.5] }, decor: P(decor) });
const crypt = (dressing: BiomeDecorLite['dressing']): BiomeDecorLite[] => [{ id: 'crypt', dressing }];
const msgs = (w: { section: string; id: string; msg: string }[]): string[] => w.map((x) => `${x.section}:${x.id}: ${x.msg}`);

describe('⭐ 12.10 (Ф2): высокий проп у ближней стены', () => {
  it('модель выше 1.5 м без отметки tall — предупреждение (как порог Unity DmDecor.TallHeight); с tall, только сокет/сор, строка .mat — нет', () => {
    expect(DECOR_TALL_HEIGHT).toBe(1.5);
    const rows = [
      art('shelf', { contexts: ['againstWall'] }, 2.0), art('shelf_ok', { contexts: ['againstWall'], tall: true }, 2.0),
      art('low', { contexts: ['againstWall'] }, 1.4), art('books', { contexts: ['socket'] }, 1.8), art('mat', { contexts: ['floor'] }, 3, 'material'),
    ];
    const w = decorWarnings([], rows);
    expect(w.map((x) => `${x.section}:${x.id}`)).toEqual(['art:shelf']);
    expect(w[0]!.msg).toContain('2.00 м');
  });

  it('биом без правил пропов: высокий проп россыпью пола или строкой objects на гранях — предупреждение (Ф1 дальних стен не различает)', () => {
    const rows = [art('pillar', { contexts: ['floor'], tall: true }, 2), art('banner', { contexts: ['wall'], tall: true }, 2), art('crate', { contexts: ['floor'] })];
    const w = decorWarnings([obj('banner_row', { modelId: 'banner', surface: 'wall' })], rows, crypt({}));
    expect(w.filter((x) => x.section === 'biomes').map((x) => x.msg.match(/«([^»]+)»/)?.[1])).toEqual(['banner_row', 'pillar']);
    // с правилами пропов — слоты ставят высокое только у дальних стен: этих предупреждений нет
    expect(msgs(decorWarnings([obj('banner_row', { modelId: 'banner', surface: 'wall' })], rows, crypt({ props: {} }))).join('\n')).not.toContain('ближних к камере');
  });
});

describe('⭐ 12.10 (Ф2): правила без пропов и проп, который слоты пропускают', () => {
  const rows = [
    art('table', { contexts: ['againstWall', 'floor'], footprint: { w: 2, h: 3 } }),
    art('crate', { contexts: ['corner', 'againstWall'] }),
    art('arch', { contexts: ['doorway'], doorway: { width: 4 }, tall: true }, 1.2),
    art('banner', { contexts: ['wall'] }),
  ];

  it('все слоты при деле — чисто; выключенный слот без пропа — чисто', () => {
    expect(decorWarnings([], rows, crypt({ props: {} }))).toEqual([]);
    expect(decorWarnings([], rows.slice(0, 3), crypt({ props: { wall: { on: false } } }))).toEqual([]);
  });

  it('включённый слот без пропа своего контекста — предупреждение биома (центр — только след от minFoot и не высокий)', () => {
    const w = decorWarnings([], rows.slice(0, 2), crypt({ props: { center: { minFoot: 3 } } }));
    expect(w.map((x) => x.msg.match(/слот «([^»]+)»/)?.[1])).toEqual(['центр комнаты', 'арка в проём', 'грань стены']);
    expect(w.every((x) => x.section === 'biomes' && x.id === 'crypt')).toBe(true);
  });

  it('проп, ни один контекст которого слоты не ставят: floor 1 × 1, doorway без ширины, угол шире 2, выключенный слот; сокет с хозяином — не предупреждение', () => {
    const odd = [
      ...rows,
      art('chair', { contexts: ['floor'] }),
      art('frame', { contexts: ['doorway'] }),
      art('long', { contexts: ['corner'], footprint: { w: 1, h: 3 } }),
      art('stool', { contexts: ['socket'], hosts: ['table'] }),
      art('lonely', { contexts: ['socket'] }),
      art('stone', { contexts: ['againstWall'] }),
    ];
    const w = decorWarnings([], odd, crypt({ props: { againstWall: { on: false } } }));
    const props = w.map((x) => x.msg.match(/^проп «([^»]+)»/)?.[1]).filter(Boolean);
    expect(props).toEqual(['chair', 'frame', 'lonely', 'long', 'stone']);   // неявные — по ключу
  });

  it('правила пропов без единого пропа с паспортом в биоме — «слоты пусты»; ссылки оформления — на отсутствующий, выключенный, чужой объект', () => {
    expect(msgs(decorWarnings([], [], crypt({ props: {} })))).toEqual(['biomes:crypt: правила пропов (dressing.props) есть, а пропов с паспортом декора у биома нет — слоты пусты']);
    const objects = [obj('torch', { surface: 'wall' }), obj('statue_off', { enabled: false }), obj('pit_caves', { biomes: ['caves'] }), obj('pit')];
    const w = decorWarnings(objects, [], crypt({ torch: { objectId: 'torh' }, statues: { objectIds: ['statue_off'] }, firePits: { objectIds: ['pit', 'pit_caves'] } }));
    expect(w.map((x) => x.msg.replace(/ — правило молча пустое$/, ''))).toEqual([
      'оформление torch: объект «torh» нет в «Объектах»', 'оформление statues: объект «statue_off» выключен', 'оформление firePits: объект «pit_caves» не из биома crypt',
    ]);
  });
});

describe('⭐ 12.10 (ревью Ф2): настенный контекст вперемешку с напольными', () => {
  it('паспорт «грань + у стены» — предупреждение арта, и слот граней его своим не считает; только wall / wallInsert — чисто', () => {
    const rows = [art('banner', { contexts: ['wall'] }), art('niche', { contexts: ['wallInsert', 'wall'] }), art('mixed', { contexts: ['wall', 'againstWall'] })];
    const w = decorWarnings([], rows);
    expect(w.map((x) => `${x.section}:${x.id}`)).toEqual(['art:mixed']);
    expect(w[0]!.msg).toContain('поверхность пол');
    // у биома с правилами: смешанный — проп «у стены», но не граней: слот граней без пропа
    const w2 = decorWarnings([], [rows[2]!], crypt({ props: { center: { on: false }, corner: { on: false }, doorway: { on: false } } }));
    expect(w2.map((x) => x.msg.match(/слот «([^»]+)»/)?.[1]).filter(Boolean)).toEqual(['грань стены']);
  });
});

describe('⭐ 12.10 (Ф2): живой конфиг', () => {
  it('без биомов — как прежде (чисто); с биомами и семенем Ф2 — чисто (грани стены крипты выключены); включить грани — пустой слот', () => {
    const reg = new ConfigRegistry();
    reg.loadAll();
    expect(decorWarnings(reg.get('objects'), reg.get('art'))).toEqual([]);
    // семя Ф2 (Unity decor_seed.json): стулья и табуреты — сокет столов, ждут наборов Ф4
    const seedF2 = reg.get('art').map((a) => (a.decor && /crypt_wooden_(chair|stool)_01/.test(a.id) ? { ...a, decor: { ...a.decor, contexts: ['socket' as const], hosts: ['crypt_wooden_table_3x_01', 'crypt_wooden_table_2x_01'] } } : a));
    // ⭐ 13.10 (ревью): у крипты нет ни одного настенного паспорта — слот граней в data выключен, «Проверить конфиг» чист (новые предупреждения не
    // прячутся за вечным)
    expect(reg.get('biomes').find((b) => b.id === 'crypt')!.dressing!.props!.wall.on).toBe(false);
    expect(decorWarnings(reg.get('objects'), seedF2, reg.get('biomes'))).toEqual([]);
    // зубы: тот же конфиг с включёнными гранями — пустой слот граней стены крипты
    const wallOn = reg.get('biomes').map((b) => (b.dressing?.props ? { ...b, dressing: { ...b.dressing, props: { ...b.dressing.props, wall: { ...b.dressing.props.wall, on: true } } } } : b));
    const w = decorWarnings(reg.get('objects'), seedF2, wallOn);
    expect(w.map((x) => `${x.section}:${x.id}:${x.msg.match(/слот «([^»]+)»/)?.[1] ?? x.msg}`)).toEqual(['biomes:crypt:грань стены']);
  });
});
