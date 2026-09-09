import { parseClientFrame } from '@dm/shared';

/**
 * Сколько стоит РАЗБОР входящего кадра ввода (npm run bench:input).
 *
 * Замер до работы, а не после: на потолке 400 игроков сервер принимает 12 000 кадров ввода
 * в секунду, и заманчиво объявить их главной статьёй расхода. Но за сутки я дважды ошибся,
 * предсказывая выигрыш до замера (uWS на сотне ботов, общая дельта), поэтому сперва цифра.
 *
 * Меряем ровно то, что делает сервер на каждом кадре: строка → JSON → проверка схемой.
 * И сравниваем с тем, во что это превратилось бы в двоичном виде.
 */
const N = Number(process.env.N ?? 2_000_000);

/** Типичный кадр ввода живого клиента: движение, поворот, атака. */
const frame = JSON.stringify({
  t: 'input',
  seq: 12345,
  input: { move: { x: 0.7071, y: -0.7071 }, facing: 2.356194, attack: true, cast: null, interact: false },
});
console.log(`кадр ввода в JSON: ${frame.length} байт`);

/** Тот же кадр двоичным: тип, номер, вектор, угол, флаги. */
const bin = new Uint8Array(8);
{
  const dv = new DataView(bin.buffer);
  dv.setUint8(0, 1);
  dv.setUint16(1, 12345);
  dv.setInt8(3, Math.round(0.7071 * 127));
  dv.setInt8(4, Math.round(-0.7071 * 127));
  dv.setUint16(5, Math.round((2.356194 / (Math.PI * 2)) * 65535));
  dv.setUint8(7, 0b01);
}
console.log(`он же двоичным: ${bin.length} байт\n`);

function bench(name: string, fn: () => void): number {
  fn();                                   // прогрев: первый проход компилирует
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) fn();
  const ns = Number(process.hrtime.bigint() - t0) / N;
  console.log(`${name.padEnd(34)} ${ns.toFixed(3)} нс/кадр`);
  return ns;
}

let sink = 0;

const json = bench('JSON.parse + проверка схемой', () => {
  const f = parseClientFrame(frame);
  if (f && f.t === 'input') sink += f.input.facing;
});

const parseOnly = bench('только JSON.parse', () => {
  const f = JSON.parse(frame) as { input: { facing: number } };
  sink += f.input.facing;
});

const binary = bench('двоичный разбор', () => {
  const dv = new DataView(bin.buffer);
  const seq = dv.getUint16(1);
  const mx = dv.getInt8(3) / 127;
  const my = dv.getInt8(4) / 127;
  const facing = (dv.getUint16(5) / 65535) * Math.PI * 2;
  const flags = dv.getUint8(7);
  sink += seq + mx + my + facing + flags;
});

// ── что это значит на нашей нагрузке ─────────────────────────────────────────
const HZ = 30;
for (const players of [400, 1000]) {
  const frames = players * HZ;
  const nowMs = (json * frames) / 1e6;
  const thenMs = (binary * frames) / 1e6;
  console.log(`\n${players} игроков × ${HZ} Гц = ${frames} кадров/с`);
  console.log(`  сейчас:  ${nowMs.toFixed(1)} мс/с  = ${(nowMs / 10).toFixed(2)} % ядра`);
  console.log(`  двоично: ${thenMs.toFixed(1)} мс/с  = ${(thenMs / 10).toFixed(2)} % ядра`);
  console.log(`  экономия ${(nowMs - thenMs).toFixed(1)} мс/с = ${((nowMs - thenMs) / 10).toFixed(2)} % ядра`);
}
console.log(`\n(проверка схемой добавляет ${(json - parseOnly).toFixed(0)} нс к разбору) [${sink.toFixed(0)}]`);
