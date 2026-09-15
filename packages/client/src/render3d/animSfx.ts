/**
 * ⭐⭐ ЗВУК ПО МЕТКАМ КЛИПА — синтезированный, без единого файла-ассета.
 *
 * До этого метки звуковой дорожки (`swing`, `sfx`, `footstep`) не делали НИЧЕГО: рантайм честно
 * собирал события (`marksInRange` → `PosePlayer.onMark`), кукла даже выставляла `onMark` наружу —
 * но подписчика не было НИ ОДНОГО (проверено поиском по всему клиенту). То есть разметка взмаха
 * в редакторе была работой в стол.
 *
 * Здесь два звука, оба генерируются WebAudio на лету:
 *  • **удар** — шумовой щелчок через полосовой фильтр + низкий «бум», быстрый спад. Это не «бип»:
 *    у настоящего удара есть и высокая атака (контакт), и низкое тело (масса);
 *  • **вжух** — шум с полосой, ЕДУЩЕЙ вверх и обратно, с нарастанием и спадом громкости. Классический
 *    swoosh: высота «проезжает» мимо слушателя.
 *
 * ⚠ ДЛИТЕЛЬНОСТЬ ВЖУХА БЕРЁТСЯ ИЗ САМОЙ МЕТКИ. `swing` — отрезок («меч пошёл» … «меч встал»), и это
 * ровно то, сколько должен звучать свист. Фиксированная длительность разошлась бы с анимацией на
 * первом же клипе с другим темпом, а тайм-варп удара растягивает `dur` вместе с движением сам.
 *
 * ⚠ ОДИН ВЖУХ НА УДАР. У клипа могут стоять И «замах» (`windup`), И «взмах» (`swing`) — это разные
 * вещи (первая про цепочку ударов, вторая про свист), и озвучивать обе значило бы свистеть дважды.
 * Поэтому `windup` звучит ТОЛЬКО если взмаха в клипе нет.
 */
import type { MarkEvent } from './clipModel.js';

/** Что играть: вид, длительность (сек) и относительная громкость. */
export interface AnimSound { kind: 'hit' | 'whoosh'; dur: number; gain: number }

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

/**
 * ⭐ ЧИСТОЕ ПРАВИЛО «метка → звук». Вся логика решения живёт здесь, чтобы её можно было проверить
 * тестом: сам синтез проверить нечем, а вот «что и когда звучит» ломается легко и молча.
 */
export function soundForMark(e: MarkEvent): AnimSound | null {
  const m = e.mark;
  if (m.type === 'impact' && e.phase === 'point') return { kind: 'hit', dur: 0.24, gain: 1 };
  if (m.type === 'swing') {
    if (e.phase !== 'begin') return null;                       // конец отрезка — это тишина, а не второй свист
    return { kind: 'whoosh', dur: clamp(m.dur ?? 0.18, 0.06, 0.8), gain: 0.85 };
  }
  if (m.type === 'windup' && e.phase === 'point') {
    // ⚠ Только когда взмаха нет: иначе на одном ударе свистело бы дважды (см. шапку).
    const hasSwing = !!e.clip?.keys.some((k) => k.marks?.some((x) => x.type === 'swing'));
    return hasSwing ? null : { kind: 'whoosh', dur: 0.2, gain: 0.7 };
  }
  return null;
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

/** Секунда белого шума — основа обоих звуков; считается один раз. */
function noiseBuf(ctx: AudioContext): AudioBuffer {
  if (_noise && _noise.sampleRate === ctx.sampleRate) return _noise;
  const n = Math.floor(ctx.sampleRate);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  _noise = buf;
  return buf;
}

/** Шумовой источник со случайным началом — два подряд удара не звучат копиями. */
function noiseSrc(ctx: AudioContext, dur: number): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf(ctx);
  src.loop = true;
  src.loopStart = 0; src.loopEnd = 1;
  const t = ctx.currentTime;
  src.start(t, Math.random() * 0.9); src.stop(t + dur + 0.02);
  return src;
}

/** УДАР: высокий контакт (шум через полосу) + низкое тело (синус вниз). */
function playHit(dur: number, g: number): void {
  const a = audio(); if (!a || a.ctx.state === 'suspended') return;
  const { ctx, master } = a; const t = ctx.currentTime;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1500; bp.Q.value = 0.8;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.0001, t);
  ng.gain.linearRampToValueAtTime(g * 0.9, t + 0.004);                      // атака 4 мс: это и есть «щелчок контакта»
  ng.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.55);
  noiseSrc(ctx, dur).connect(bp).connect(ng).connect(master);

  const osc = ctx.createOscillator(); osc.type = 'sine';
  osc.frequency.setValueAtTime(140, t);
  osc.frequency.exponentialRampToValueAtTime(46, t + dur);                  // «бум»: масса слышна как падение высоты
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.0001, t);
  og.gain.linearRampToValueAtTime(g * 0.8, t + 0.008);
  og.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(og).connect(master);
  osc.start(t); osc.stop(t + dur + 0.02);
}

/** ВЖУХ: полоса шума проезжает вверх и обратно, громкость нарастает к середине. */
function playWhoosh(dur: number, g: number): void {
  const a = audio(); if (!a || a.ctx.state === 'suspended') return;
  const { ctx, master } = a; const t = ctx.currentTime;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
  bp.frequency.setValueAtTime(320, t);
  bp.frequency.exponentialRampToValueAtTime(1700, t + dur * 0.55);          // проезд мимо слушателя
  bp.frequency.exponentialRampToValueAtTime(420, t + dur);
  const gn = ctx.createGain();
  gn.gain.setValueAtTime(0.0001, t);
  gn.gain.linearRampToValueAtTime(g * 0.55, t + dur * 0.45);
  gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  noiseSrc(ctx, dur).connect(bp).connect(gn).connect(master);
}

/** Проиграть решение `soundForMark`. Громкость источника (свой игрок / пир) — множителем. */
export function playAnimSound(s: AnimSound, gain = 1): void {
  const g = s.gain * clamp(gain, 0, 1);
  if (g <= 0.001) return;
  if (s.kind === 'hit') playHit(s.dur, g); else playWhoosh(s.dur, g);
}

/** Подписчик для `doll.onMark`: метка → решение → звук. Ничего не решает сам — это делает `soundForMark`. */
export function markSfx(gain = 1): (e: MarkEvent) => void {
  return (e: MarkEvent): void => { const s = soundForMark(e); if (s) playAnimSound(s, gain); };
}
