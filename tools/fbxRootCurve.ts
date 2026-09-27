/**
 * ⭐⭐ АВТОРСКАЯ КРИВАЯ ПОВОРОТА КОРНЯ — ПРЯМО ИЗ БИНАРНОГО FBX.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ЧИТАТЕЛЬ, РАЗ ЕСТЬ FBXLoader. Потому что он эту кривую ТЕРЯЕТ. Замер на пакете
 * Kubold: у тейка `TurnRt90_Loop` в файле узел `Root`, свойство `Lcl Rotation`, канал Y — **40 ключей,
 * 0 → −90.0000°** (X и Z по одному ключу: анимирован только рыск), у `TurnRt180` — 51 ключ до −180.0000°.
 * А `new FBXLoader().parse(...)` отдаёт `Root.quaternion` С ОДНИМ ключом-единицей.
 *
 * Цена ошибки была велика: не видя кривой, мы восстанавливали её из рыска опорной стопы
 * (`clipBaker.yawFromSupportFoot`) и получали −88 вместо −90, −169 вместо −180 — и С ОБРАТНЫМ ЗНАКОМ,
 * потому что у Kubold `Lt` = +90° (поворот в свою левую), а у нас `turn_L` отрицательный. Тело крутилось
 * в одну сторону, ноги переступали в другую: «повернулось наполовину».
 *
 * ⚠ ЖИВЁТ В `tools/`, а не в клиенте: это читатель бинарного формата, в бандл игры ему незачем.
 * Набор собирается здесь же (`tools/mocapSet.ts`), а в клипы уходят уже готовые числа.
 *
 * Формат (FBX Binary): заголовок 27 байт, дальше дерево записей
 * [EndOffset, NumProperties, PropertyListLen, NameLen, Name, свойства…, вложенные…, нулевая запись].
 * С версии 7500 смещения 64-битные. Массивы бывают сжаты zlib.
 */
import { inflateSync } from 'node:zlib';

interface FbxNode { name: string; props: unknown[]; kids: FbxNode[] }

/** Одна кривая: времена (сек) и значения (градусы). */
export interface RootYawCurve { take: string; times: number[]; deg: number[] }

/** Тик FBX-времени: 46 186 158 000 на секунду — константа формата, не наша. */
const FBX_TICK = 46186158000;

export function readRootYawCurves(file: string, data: Buffer): Map<string, RootYawCurve> {
  const ver = data.readUInt32LE(23);
  const wide = ver >= 7500;
  const W = wide ? 8 : 4;
  const NULLREC = wide ? 25 : 13;
  const off = (o: number): number => (wide ? Number(data.readBigUInt64LE(o)) : data.readUInt32LE(o));

  function readProp(o: number): [unknown, number] {
    const t = String.fromCharCode(data[o]!); o += 1;
    switch (t) {
      case 'Y': return [data.readInt16LE(o), o + 2];
      case 'C': return [data[o] !== 0, o + 1];
      case 'I': return [data.readInt32LE(o), o + 4];
      case 'F': return [data.readFloatLE(o), o + 4];
      case 'D': return [data.readDoubleLE(o), o + 8];
      case 'L': return [Number(data.readBigInt64LE(o)), o + 8];
      case 'f': case 'd': case 'l': case 'i': case 'b': {
        const n = data.readUInt32LE(o), enc = data.readUInt32LE(o + 4), clen = data.readUInt32LE(o + 8);
        o += 12;
        let raw = data.subarray(o, o + clen); o += clen;
        if (enc) raw = inflateSync(raw);
        const out: number[] = [];
        for (let i = 0; i < n; i++) {
          if (t === 'f') out.push(raw.readFloatLE(i * 4));
          else if (t === 'd') out.push(raw.readDoubleLE(i * 8));
          else if (t === 'l') out.push(Number(raw.readBigInt64LE(i * 8)));
          else if (t === 'i') out.push(raw.readInt32LE(i * 4));
          else out.push(raw[i]!);
        }
        return [out, o];
      }
      case 'S': case 'R': {
        const n = data.readUInt32LE(o); o += 4;
        const v = data.subarray(o, o + n); o += n;
        return [t === 'S' ? v.toString('utf8') : v, o];
      }
      default: throw new Error(`${file}: неизвестный тип свойства «${t}»`);
    }
  }

  function readNode(o: number): [FbxNode | null, number] {
    const end = off(o), nprops = off(o + W);
    o += 3 * W;
    const nl = data[o]!; o += 1;
    const name = data.subarray(o, o + nl).toString('utf8'); o += nl;
    if (end === 0) return [null, o];
    const props: unknown[] = [];
    for (let i = 0; i < nprops; i++) { const [v, o2] = readProp(o); props.push(v); o = o2; }
    const kids: FbxNode[] = [];
    while (o < end - NULLREC) { const [k, o2] = readNode(o); o = o2; if (!k) break; kids.push(k); }
    return [{ name, props, kids }, end];
  }

  const top: FbxNode[] = [];
  let o = 27;
  while (o < data.length - 20) {
    const [n, o2] = readNode(o);
    if (!n || o2 <= o) break;
    top.push(n); o = o2;
  }

  const objs = top.find((n) => n.name === 'Objects')?.kids ?? [];
  const conns = top.find((n) => n.name === 'Connections')?.kids ?? [];
  const byId = new Map<number, { cls: string; name: string }>();
  for (const n of objs) {
    const id = n.props[0];
    if (typeof id === 'number') byId.set(id, { cls: n.name, name: String(n.props[1] ?? '').split('\0')[0]! });
  }
  /** child → [(parent, свойство)] */
  const up = new Map<number, [number, string | null][]>();
  for (const c of conns) {
    const [, child, parent, prop] = c.props as [string, number, number, string | undefined];
    if (typeof child !== 'number' || typeof parent !== 'number') continue;
    const arr = up.get(child) ?? []; arr.push([parent, prop ?? null]); up.set(child, arr);
  }

  const out = new Map<string, RootYawCurve>();
  for (const cv of objs) {
    if (cv.name !== 'AnimationCurve') continue;
    const cid = cv.props[0] as number;
    for (const [nodeId] of up.get(cid) ?? []) {
      const cn = byId.get(nodeId);
      if (cn?.cls !== 'AnimationCurveNode') continue;
      for (const [modelId, prop] of up.get(nodeId) ?? []) {
        const mdl = byId.get(modelId);
        if (!mdl || mdl.name !== 'Root' || !prop || !prop.includes('Rotation')) continue;
        const deg = cv.kids.find((k) => k.name === 'KeyValueFloat')?.props[0] as number[] | undefined;
        const tick = cv.kids.find((k) => k.name === 'KeyTime')?.props[0] as number[] | undefined;
        // ⚠ Каналов три (X/Y/Z), анимирован только рыск — берём тот, где ключей больше одного.
        if (!deg || !tick || deg.length < 2) continue;
        // тейк — через слой к стеку
        for (const [layerId] of up.get(nodeId) ?? []) {
          if (byId.get(layerId)?.cls !== 'AnimationLayer') continue;
          for (const [stackId] of up.get(layerId) ?? []) {
            const st = byId.get(stackId);
            if (st?.cls !== 'AnimationStack') continue;
            const t0 = tick[0]!;
            out.set(st.name, { take: st.name, times: tick.map((t) => (t - t0) / FBX_TICK), deg: [...deg] });
          }
        }
      }
    }
  }
  return out;
}

/** Значение кривой в момент `t` (сек), линейно между ключами. Вне диапазона — зажим. */
export function sampleCurve(c: RootYawCurve, t: number): number {
  const n = c.times.length;
  if (!n) return 0;
  if (t <= c.times[0]!) return c.deg[0]!;
  if (t >= c.times[n - 1]!) return c.deg[n - 1]!;
  let i = 1;
  while (i < n && c.times[i]! < t) i++;
  const a = c.times[i - 1]!, b = c.times[i]!;
  const u = b > a ? (t - a) / (b - a) : 0;
  return c.deg[i - 1]! + (c.deg[i]! - c.deg[i - 1]!) * u;
}
