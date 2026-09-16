/**
 * ⭐⭐ ЗВУК ПО МЕТКАМ КЛИПА — синтезированный, без единого файла-ассета.
 *
 * До этого метки звуковой дорожки (`swing`, `sfx`, `footstep`) не делали НИЧЕГО: рантайм честно
 * собирал события (`marksInRange` → `PosePlayer.onMark`), кукла даже выставляла `onMark` наружу —
 * но подписчика не было НИ ОДНОГО (проверено поиском по всему клиенту). То есть разметка взмаха
 * в редакторе была работой в стол.
 *
 * Все звуки генерируются WebAudio на лету:
 *  • **удар** — шумовой щелчок через полосовой фильтр + низкий «бум», быстрый спад. Это не «бип»:
 *    у настоящего удара есть и высокая атака (контакт), и низкое тело (масса);
 *  • **вжух** — шум с полосой, ЕДУЩЕЙ вверх и обратно, с нарастанием и спадом громкости. Классический
 *    swoosh: высота «проезжает» мимо слушателя;
 *  • **шаг** — мягкая кожаная подошва по камню (см. `renderStep`).
 *
 * ⚠ РЕШЕНИЯ ПО ВСЕМ ДОРОЖКАМ ЖИВУТ ЗДЕСЬ — звук, тряска камеры, эффект. Синтезируется здесь только
 * звук, остальное отдаётся своим системам; но правило «что делает эта метка» должно читаться В ОДНОМ
 * МЕСТЕ, иначе на вопрос «а что у нас вообще делают метки» снова не будет ответа.
 *
 * ⚠ ДЛИТЕЛЬНОСТЬ ВЖУХА БЕРЁТСЯ ИЗ САМОЙ МЕТКИ. `swing` — отрезок («меч пошёл» … «меч встал»), и это
 * ровно то, сколько должен звучать свист. Фиксированная длительность разошлась бы с анимацией на
 * первом же клипе с другим темпом, а тайм-варп удара растягивает `dur` вместе с движением сам.
 *
 * ⚠ ОДИН ВЖУХ НА УДАР. У клипа могут стоять И «замах» (`windup`), И «взмах» (`swing`) — это разные
 * вещи (первая про цепочку ударов, вторая про свист), и озвучивать обе значило бы свистеть дважды.
 * Поэтому `windup` звучит ТОЛЬКО если взмаха в клипе нет.
 *
 * ⚠ СИНТЕЗ СОБИРАЕТСЯ В ЛЮБОЙ КОНТЕКСТ (`renderAnimSound`): живой — в игре, офлайн — для замера и записи
 * в файл. Иначе проверить, КАК звучит шаг, было бы можно только ушами в игре.
 */
import type { MarkEvent } from './clipModel.js';
import type { HitMaterial } from '@dm/shared';

/** Пол под ногами. Материал поверхности знает МИР, а не клип (см. метку `footstep`); пока пол один — камень. */
export type StepSurface = 'stone';

/** Что играть: вид, длительность (сек) и относительная громкость. */
export interface AnimSound {
  kind: 'hit' | 'whoosh' | 'step' | 'clank'; dur: number; gain: number; tone?: number; mat?: HitMaterial;
  /** Шаг: темп хода 0 (на месте) … 1 (бег) и пол. */
  pace?: number; surface?: StepSurface;
}

/**
 * ⚠ ЗАГЛУШКА, НО РАЗЛИЧИМАЯ. Метка `sfx` несёт ID звука из конфига — а конфига звуков не
 * существует, поэтому честного «того самого» звука взять неоткуда. Вместо молчания даём узнаваемый
 * тембр по знакомым словам (и нейтральный лязг на всё прочее): разметку слышно и её видно в работе,
 * а подмена библиотекой сэмплов потом сведётся к замене этой таблицы.
 */
const SFX_TONE: ReadonlyArray<readonly [RegExp, number]> = [
  [/(clank|лязг|щит|shield)/i, 1],
  [/(shout|крик|выкрик|voice)/i, 1.9],
  [/(rustle|шорох|броня|armor|cloth)/i, 0.55],
  [/(step|шаг|foot)/i, 0.7],
];

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

/**
 * Темп шага, если его не сообщили (метка шага в клипе удара, превью в редакторе): обычный шаг.
 * Проигрыватель походки ставит темп сам — по скорости (`PosePlayer`).
 */
export const STEP_PACE_DEFAULT = 0.45;

/**
 * ⭐ ЧИСТОЕ ПРАВИЛО «метка → звук». Вся логика решения живёт здесь, чтобы её можно было проверить
 * тестом: сам синтез проверить нечем, а вот «что и когда звучит» ломается легко и молча.
 */
export function soundForMark(e: MarkEvent): AnimSound | null {
  const m = e.mark;
  // ⚠⚠ МЕТКА `impact` МОЛЧИТ, И ЭТО НЕ ПОТЕРЯ. Раньше звук удара висел ровно здесь — и потому
  // звучал ВСЕГДА, даже когда махнул по воздуху: клип не знает ни попал ли ты, ни во что попал.
  // Звук удара теперь едет от СОБЫТИЯ удара (`soundForHit`), у которого есть и попадание, и блок,
  // и материал цели. Метка при этом осталась при своём деле — она ставит МОМЕНТ урона в анимации.
  if (m.type === 'swing') {
    if (e.phase !== 'begin') return null;                       // конец отрезка — это тишина, а не второй свист
    return { kind: 'whoosh', dur: clamp(m.dur ?? 0.18, 0.06, 0.8), gain: 0.85 };
  }
  if (m.type === 'footstep' && e.phase === 'point') {
    // ⭐ ГРОМКОСТЬ — ОТ ТЕМПА: подшаг на месте едва слышен, бег топает. Один уровень на всё звучал бы либо
    // слишком громко на повороте, либо беззвучно на бегу.
    // ⚠ Левая и правая — ЧУТЬ РАЗНОЙ высоты: одинаковые шаги подряд слышны как повтор сэмпла. Именно чуть:
    // разница в пятую часть тона превращала ходьбу в «тик-так».
    const pace = clamp(e.pace ?? STEP_PACE_DEFAULT, 0, 1);
    return { kind: 'step', dur: 0.26, gain: 0.3 + 0.55 * pace, tone: m.foot === 'R' ? 1.035 : 0.965, pace, surface: 'stone' };
  }
  if (m.type === 'sfx' && e.phase === 'point') {
    const id = m.sfx ?? '';
    const tone = SFX_TONE.find(([re]) => re.test(id))?.[1] ?? 1;
    return { kind: 'clank', dur: 0.22, gain: 0.7, tone };
  }
  if (m.type === 'windup' && e.phase === 'point') {
    // ⚠ Только когда взмаха нет: иначе на одном ударе свистело бы дважды (см. шапку).
    const hasSwing = !!e.clip?.keys.some((k) => k.marks?.some((x) => x.type === 'swing'));
    return hasSwing ? null : { kind: 'whoosh', dur: 0.2, gain: 0.7 };
  }
  return null;
}

/**
 * ⭐⭐ ТЕМБР УДАРА ПО МАТЕРИАЛУ ЦЕЛИ. Заглушка — но РАЗЛИЧИМАЯ, как и остальные синтезированные звуки:
 * сэмплов нет, а «латы против кожи» слышно должно быть уже сейчас.
 *
 * Три ручки, и каждая отвечает за то, что слышно ушами:
 *  • `band` — высота контакта (шум через полосу): сталь звенит высоко, стёганка глохнет внизу;
 *  • `metal` — сколько в звуке ПРИЗВУКОВ (несоизмеримые обертоны = металл; 0 = глухой шлепок);
 *  • `body`/`dur` — низ и хвост: у лат он длинный и звонкий, у тела короткий и мокрый.
 */
const MAT_TIMBRE: Record<HitMaterial, { band: number; metal: number; body: number; dur: number }> = {
  flesh: { band: 420, metal: 0, body: 90, dur: 0.22 },        // мокрый низкий шлепок
  quilted: { band: 620, metal: 0, body: 160, dur: 0.17 },     // совсем глухо — стёганка гасит
  leather: { band: 950, metal: 0, body: 150, dur: 0.20 },     // кожаный хлопок, без звона
  chain: { band: 4200, metal: 0.45, body: 120, dur: 0.26 },   // дребезг колец: высоко и рассыпчато
  segmented: { band: 2600, metal: 0.7, body: 125, dur: 0.30 },
  plate: { band: 3200, metal: 1, body: 110, dur: 0.42 },      // звонкий лязг с долгим хвостом
};

/** Событие удара с сервера в терминах звука: попал ли, заблокировали ли, во что и чей это удар. */
export interface HitSoundInput { hit: boolean; blocked: boolean; crit: boolean; mat: HitMaterial }

/**
 * ⭐⭐ ЧИСТОЕ ПРАВИЛО «событие удара → звук». Промах МОЛЧИТ — ради этого всё и затевалось.
 *
 * ⚠ Блок звучит щитом, а не бронёй: приняли на щит — материал цели уже ни при чём, и слышно должно
 * быть именно «отбил», иначе игрок не отличит блок от попадания на слух.
 * ⚠ Крит — тот же материал, но громче и длиннее: отдельный «крит-звук» поверх обычного читался бы
 * как второй удар.
 */
export function soundForHit(e: HitSoundInput): AnimSound | null {
  if (e.blocked) return { kind: 'clank', dur: 0.3, gain: 1, tone: 0.75 };   // низкий тяжёлый лязг щита
  if (!e.hit) return null;                                                  // промах — тишина (свист уже отыграл взмах)
  const t = MAT_TIMBRE[e.mat] ?? MAT_TIMBRE.flesh;
  return { kind: 'hit', dur: t.dur * (e.crit ? 1.25 : 1), gain: e.crit ? 1 : 0.85, mat: e.mat };
}

/**
 * СЛЫШНОСТЬ ПО РАССТОЯНИЮ (единицы мира): вплотную — полностью, дальше — плавно на нет. Без неё чужие шаги
 * сливались бы в сплошной топот: сервер присылает всех игроков в окне, а не только соседей.
 * Квадрат, а не прямая: на слух громкость падает быстрее расстояния.
 */
export const EAR_NEAR = 160, EAR_FAR = 640;
export function earShot(dx: number, dz: number): number {
  const d = Math.hypot(dx, dz);
  if (d <= EAR_NEAR) return 1;
  if (d >= EAR_FAR) return 0;
  const k = 1 - (d - EAR_NEAR) / (EAR_FAR - EAR_NEAR);
  return k * k;
}

// ── Синтез ───────────────────────────────────────────────────────────────────────────────────────
let _ctx: AudioContext | null = null;
let _master: GainNode | null = null;
let _noise: AudioBuffer | null = null;
let _volume = 0.5;
let _unlocked = false;

/** Контекст создаётся ЛЕНИВО и будится первым жестом — политика автоплея браузеров. */
function audio(): { ctx: AudioContext; master: GainNode } | null {
  if (typeof window === 'undefined' || typeof AudioContext === 'undefined') return null;
  if (!_ctx) {
    _ctx = new AudioContext();
    _master = _ctx.createGain(); _master.gain.value = _volume; _master.connect(_ctx.destination);
    if (!_unlocked) {
      _unlocked = true;
      const wake = (): void => { void _ctx?.resume(); };
      window.addEventListener('pointerdown', wake);
      window.addEventListener('keydown', wake);
    }
  }
  return _ctx && _master ? { ctx: _ctx, master: _master } : null;
}

/** Общая громкость звуков анимации (0…1). */
export function setAnimSfxVolume(v: number): void {
  _volume = clamp(v, 0, 1);
  if (_master) _master.gain.value = _volume;
}

/** Секунда белого шума — основа всех звуков; считается один раз на частоту дискретизации. */
function noiseBuf(ctx: BaseAudioContext): AudioBuffer {
  if (_noise && _noise.sampleRate === ctx.sampleRate) return _noise;
  const n = Math.floor(ctx.sampleRate);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  _noise = buf;
  return buf;
}

/** Шумовой источник со случайным началом — два подряд звука не звучат копиями. */
function noiseSrc(ctx: BaseAudioContext, t0: number, dur: number, rnd: () => number): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf(ctx);
  src.loop = true;
  src.loopStart = 0; src.loopEnd = 1;
  src.start(t0, rnd() * 0.9); src.stop(t0 + dur + 0.02);
  return src;
}

/** Огибающая «щелчок и спад»: атака `att`, экспонента до тишины к `t0 + dec`. */
function decayEnv(ctx: BaseAudioContext, t0: number, peak: number, att: number, dec: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(Math.max(0.0002, peak), t0 + att);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(att + 0.005, dec));
  return g;
}

/** УДАР: высокий контакт (шум через полосу) + низкое тело (синус вниз) + призвуки металла по материалу. */
function renderHit(ctx: BaseAudioContext, out: AudioNode, t: number, dur: number, g: number, mat: HitMaterial, rnd: () => number): void {
  const tb = MAT_TIMBRE[mat] ?? MAT_TIMBRE.flesh;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
  bp.frequency.value = tb.band; bp.Q.value = 0.8 + tb.metal * 3;            // металл = уже полоса, то есть звонче
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.0001, t);
  ng.gain.linearRampToValueAtTime(g * 0.9, t + 0.004);                      // атака 4 мс: это и есть «щелчок контакта»
  ng.gain.exponentialRampToValueAtTime(0.0001, t + dur * (0.35 + tb.metal * 0.4));
  noiseSrc(ctx, t, dur, rnd).connect(bp).connect(ng).connect(out);

  const osc = ctx.createOscillator(); osc.type = 'sine';
  osc.frequency.setValueAtTime(tb.body, t);
  osc.frequency.exponentialRampToValueAtTime(tb.body * 0.33, t + dur);      // «бум»: масса слышна как падение высоты
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.0001, t);
  og.gain.linearRampToValueAtTime(g * 0.8, t + 0.008);
  og.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(og).connect(out);
  osc.start(t); osc.stop(t + dur + 0.02);

  // ⚠ ПРИЗВУКИ — ТОЛЬКО У МЕТАЛЛА и НЕСОИЗМЕРИМЫЕ по частоте: кратные дали бы музыкальный тон, то есть «бип».
  if (tb.metal > 0.01) for (const [mul, lvl] of [[1, 0.42], [1.59, 0.26], [2.37, 0.16]] as const) {
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = tb.band * mul;
    const gg = ctx.createGain();
    gg.gain.setValueAtTime(g * lvl * tb.metal, t);
    gg.gain.exponentialRampToValueAtTime(0.0001, t + dur);                  // звон живёт весь хвост — он и есть «латы»
    o.connect(gg).connect(out); o.start(t); o.stop(t + dur + 0.02);
  }
}

/** ВЖУХ: полоса шума проезжает вверх и обратно, громкость нарастает к середине. */
function renderWhoosh(ctx: BaseAudioContext, out: AudioNode, t: number, dur: number, g: number, rnd: () => number): void {
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
  bp.frequency.setValueAtTime(320, t);
  bp.frequency.exponentialRampToValueAtTime(1700, t + dur * 0.55);          // проезд мимо слушателя
  bp.frequency.exponentialRampToValueAtTime(420, t + dur);
  const gn = ctx.createGain();
  gn.gain.setValueAtTime(0.0001, t);
  gn.gain.linearRampToValueAtTime(g * 0.55, t + dur * 0.45);
  gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  noiseSrc(ctx, t, dur, rnd).connect(bp).connect(gn).connect(out);
}

/**
 * Подошва × пол. Пара пока одна — мягкая кожа по камню; появится материал пола от мира — добавится строка.
 *  • `heel`/`toe` — середина полосы касания пятки и носка (Гц): кожа гасит верх, звук сидит низко;
 *  • `crisp` — полоса короткого «тк» самого камня под подошвой (у дерева его нет, у камня он и есть камень);
 *  • `body` — едва слышный вес (Гц): у кожи по камню низа мало, это не сапог по доскам;
 *  • `grit` — зернистый шорох песка между подошвой и камнем (Гц);
 *  • `dec` — спад касания (сек).
 */
/**
 * ⚠ КАЛИБРОВКА ГРОМКОСТИ ШАГА — ПО A-ВЗВЕШЕННОМУ УРОВНЮ, А НЕ ПО RMS. У удара почти вся энергия — низкий «бум»
 * (90 Гц), который уши и маленькие колонки почти не слышат, а шаг сидит в 0.2–4 кГц, где слух острее всего.
 * По RMS шаг ходьбы был втрое тише удара — а на слух на 7 дБ ГРОМЧЕ. Замер офлайн-рендером (8 прогонов,
 * громкость относительно удара по телу): подшаг на месте −12 дБ(A), шаг −8, бег −5.5; для масштаба взмах +4,
 * удар по коже +5, по латам +17. Спектр шага ходьбы: центр 1.07 кГц, 50 % энергии в 0.2–1 кГц, выше 4 кГц — 1 %,
 * спад на 20 дБ за 51 мс — глухо и без щелчка, то есть мягкая подошва, а не каблук.
 */
const STEP_LEVEL = 0.167;
const STEP_TIMBRE: Record<StepSurface, { heel: number; toe: number; crisp: number; body: number; grit: number; dec: number }> = {
  stone: { heel: 520, toe: 780, crisp: 2900, body: 92, grit: 3000, dec: 0.16 },
};

/**
 * ⭐⭐ ШАГ: МЯГКАЯ КОЖАНАЯ ПОДОШВА ПО КАМЕННОМУ ПОЛУ.
 *
 * Что слышно у такого шага и чем это собрано:
 *  • ПЯТКА — глухое «туп» без щелчка: мягкая кожа жёсткого контакта не даёт. Шум через полосу ~0.56 кГц
 *    с подрезанным верхом, атака 3 мс (короче — уже щелчок каблука, другая обувь), спад ~85 мс;
 *  • КАМЕНЬ — короткое тихое «тк» ~2.9 кГц поверх пятки: жёсткий пол под мягкой подошвой;
 *  • ВЕС — едва слышный низ 92 → 58 Гц;
 *  • НОСОК — второе, чуть более светлое касание через 55–80 мс: перекат с пятки. На бегу перекат
 *    схлопывается (стопа ставится сразу на подушку), касание одно, но звонче и суше;
 *  • ПЕСОК — зернистый шорох 1.5–7 кГц, тихий; на бегу громче (подошву протаскивает).
 *
 * ⚠ КАЖДЫЙ ШАГ ЧУТЬ ДРУГОЙ: полоса ±12 %, спад ±15 %, громкость ±12 %, задержка носка ±18 %, песок ±30 %.
 * Одинаковые шаги подряд слышны как «пулемёт» одного сэмпла, а не как ходьба.
 */
function renderStep(ctx: BaseAudioContext, out: AudioNode, t: number, s: AnimSound, g: number, rnd: () => number): void {
  const tb = STEP_TIMBRE[s.surface ?? 'stone'] ?? STEP_TIMBRE.stone;
  const vary = (a: number): number => 1 + (rnd() * 2 - 1) * a;            // случайный множитель 1 ± a
  const pace = clamp(s.pace ?? STEP_PACE_DEFAULT, 0, 1), tone = s.tone ?? 1;
  const gg = g * STEP_LEVEL * vary(0.12);
  const dec = tb.dec * vary(0.15) * (1 - 0.3 * pace);                        // бег — короче и суше
  const bright = 1 + 0.22 * pace;                                            // бег — звонче: удар сильнее
  /** Одно касание: шум через полосу, верх подрезан (кожа), плюс тихое «тк» камня. */
  const touch = (at: number, band: number, lvl: number, d: number, crispLvl: number): void => {
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = band; bp.Q.value = 0.8;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = band * 3.2;
    noiseSrc(ctx, at, d, rnd).connect(bp).connect(lp).connect(decayEnv(ctx, at, lvl, 0.003, d)).connect(out);
    const cp = ctx.createBiquadFilter(); cp.type = 'bandpass'; cp.frequency.value = tb.crisp * tone * vary(0.1); cp.Q.value = 1.6;
    noiseSrc(ctx, at, 0.05, rnd).connect(cp).connect(decayEnv(ctx, at, lvl * crispLvl, 0.0015, 0.028)).connect(out);
  };
  touch(t, tb.heel * tone * bright * vary(0.12), gg * 2.4, dec, 0.12 + 0.18 * pace);
  // Вес: тихо — у кожи по камню низа почти нет.
  const osc = ctx.createOscillator(); osc.type = 'sine';
  osc.frequency.setValueAtTime(tb.body * tone, t);
  osc.frequency.exponentialRampToValueAtTime(tb.body * tone * 0.63, t + 0.07);
  osc.connect(decayEnv(ctx, t, gg * 0.12, 0.004, 0.075)).connect(out);
  osc.start(t); osc.stop(t + 0.1);
  // Носок: перекат с пятки. На бегу задержка уходит в ноль — касание одно.
  const lag = 0.068 * vary(0.18) * (1 - pace);
  if (lag > 0.014) touch(t + lag, tb.toe * tone * vary(0.12), gg * 2.4 * (0.5 + 0.2 * rnd()), dec * 0.7, 0.1);
  // Песок: зернистый шорох подошвы по камню.
  const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = tb.grit * 0.5;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = tb.grit * 1.6;
  const gritAt = t + 0.006, gritDec = (0.1 + 0.07 * pace) * vary(0.2);
  noiseSrc(ctx, gritAt, gritDec + 0.02, rnd).connect(hp).connect(lp)
    .connect(decayEnv(ctx, gritAt, gg * (0.035 + 0.06 * pace) * vary(0.3), 0.006, gritDec)).connect(out);
}

/** ЛЯЗГ (и прочие «сторонние» звуки): узкая полоса шума + два призвука — металлический, короткий. */
function renderClank(ctx: BaseAudioContext, out: AudioNode, t: number, dur: number, g: number, tone: number, rnd: () => number): void {
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2400 * tone; bp.Q.value = 6;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.0001, t);
  ng.gain.linearRampToValueAtTime(g * 0.8, t + 0.003);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  noiseSrc(ctx, t, dur, rnd).connect(bp).connect(ng).connect(out);
  for (const [mul, lvl] of [[1, 0.5], [1.48, 0.3]] as const) {   // несоизмеримые призвуки = металл, а не бип
    const osc = ctx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 1700 * tone * mul;
    const og = ctx.createGain();
    og.gain.setValueAtTime(g * lvl, t);
    og.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.8);
    osc.connect(og).connect(out); osc.start(t); osc.stop(t + dur + 0.02);
  }
}

/**
 * Собрать звук в ЛЮБОЙ контекст на момент `t0`: живой (игра) или офлайн (замер, запись в файл).
 * `rnd` — источник разброса: офлайн его можно зафиксировать, чтобы замер повторялся.
 */
export function renderAnimSound(ctx: BaseAudioContext, out: AudioNode, t0: number, s: AnimSound, gain = 1, rnd: () => number = Math.random): void {
  const g = s.gain * clamp(gain, 0, 1);
  if (g <= 0.001) return;
  const tone = s.tone ?? 1;
  if (s.kind === 'hit') renderHit(ctx, out, t0, s.dur, g, s.mat ?? 'flesh', rnd);
  else if (s.kind === 'whoosh') renderWhoosh(ctx, out, t0, s.dur, g, rnd);
  else if (s.kind === 'step') renderStep(ctx, out, t0, s, g, rnd);
  else renderClank(ctx, out, t0, s.dur, g, tone, rnd);
}

/** Проиграть решение `soundForMark`. Громкость источника (свой игрок / пир) — множителем. */
export function playAnimSound(s: AnimSound, gain = 1): void {
  const a = audio(); if (!a || a.ctx.state === 'suspended') return;
  renderAnimSound(a.ctx, a.master, a.ctx.currentTime, s, gain);
}

/**
 * ⭐ СИЛА ТРЯСКИ по метке `camshake`. Живёт рядом со звуком по одной причине: это такое же чистое
 * правило «метка → величина», и держать его в коде камеры значило бы прятать решение в отрисовке.
 * Сила берётся из самой метки (`num`) — чтобы масштабировать её от тяжести удара.
 */
export function shakeForMark(e: MarkEvent): number {
  if (e.mark.type !== 'camshake' || e.phase !== 'point') return 0;
  const n = e.mark.num;
  return n === undefined ? 1 : Math.max(0, n);
}

/**
 * ⭐ ЭФФЕКТ по метке `vfx`.
 *
 * ⚠ ЗАГЛУШКА, КАК И У ЗВУКА: метка несёт ID эффекта из конфига, а библиотеки эффектов не существует.
 * Поэтому знакомые слова дают узнаваемый цвет, всё прочее — нейтральную искру. Метка при этом
 * ВИДНА в работе, а появление настоящей библиотеки сведётся к замене этой таблицы.
 */
const VFX_COLOR: ReadonlyArray<readonly [RegExp, number]> = [
  [/(blood|кровь)/i, 0xc0402a],
  [/(dust|пыль|земл)/i, 0x9c8b6a],
  [/(smoke|дым)/i, 0x6b7280],
  [/(spark|искр|огон|fire)/i, 0xffb04a],
];
export interface AnimBurst { color: number; n: number; speed: number; life: number }
export function burstForMark(e: MarkEvent): AnimBurst | null {
  if (e.mark.type !== 'vfx' || e.phase !== 'point') return null;
  const id = e.mark.vfx ?? '';
  return { color: VFX_COLOR.find(([re]) => re.test(id))?.[1] ?? 0xffe6a0, n: 12, speed: 70, life: 0.45 };
}

/** Проиграть звук события удара (сервер уже решил: попал / заблокировали / во что). */
export function playHitSound(e: HitSoundInput, gain = 1): void {
  const s = soundForHit(e);
  if (s) playAnimSound(s, gain);
}

/**
 * Подписчик для `doll.onMark`: метка → решение → звук. Ничего не решает сам — это делает `soundForMark`.
 * Громкость — число или функция: чужому игроку её считают В МОМЕНТ звука, по расстоянию (`earShot`).
 */
export function markSfx(gain: number | (() => number) = 1): (e: MarkEvent) => void {
  return (e: MarkEvent): void => {
    const s = soundForMark(e);
    if (s) playAnimSound(s, typeof gain === 'function' ? gain() : gain);
  };
}
