/**
 * ⭐ СТОРОЖ ГЕОМЕТРИИ КЛИНКОВ (§26). Статы клинка считаются из `weapon-parts[].geom`, а `geom` снят
 * измерителем с процедурной заглушки. Правка формы в `blades.ts` (или ручной оси, от которой у
 * заглушки зависит ширина) без нового замера молча разошлась бы со статами — этот тест ловит.
 *
 * Перемерить и записать: `DM_WRITE_BLADE_GEOM=1 npx vitest run bladeGeom` — меняются ТОЛЬКО строки
 * клинков, остальной файл (одна деталь на строку, CRLF) остаётся байт-в-байт.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ConfigRegistry, clampStep, defaultParts, type CraftParts } from '@dm/shared';
import { buildCraftMesh } from './index.js';
import { geomOf, measureBlade, type BladeMeasure } from './bladeGeom.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PARTS_JSON = join(HERE, '../../../../../shared/src/config/data/weapon-parts.json');

const reg = new ConfigRegistry();
reg.loadAll();

/** Замер заглушки ударной части: собираем эталонное оружие с этим клинком и меряем гнездо `strike`. */
function measurePart(id: string): BladeMeasure | null {
  const b = reg.get('weapon-parts').find((p) => p.id === id)!;
  const cls = b.classes[0]!;
  const hands = b.hands.includes(2) ? 2 : 1;
  const def = defaultParts(reg, cls, hands, 2);
  if (!def) return null;
  const input = structuredClone(def) as CraftParts;
  input.strike = { id: b.id, step: clampStep(b, 2) };
  const res = buildCraftMesh(reg, cls, hands, input);
  if (!res) return null;
  const g = res.group.children.find((c) => c.name === 'strike');
  const m = g ? measureBlade(g) : null;
  res.dispose();
  return m;
}

/** Клинки, которые несут статы геометрии: мечевые ударные части. */
const swordBlades = reg.get('weapon-parts').filter((p) => p.slot === 'strike' && (p.classes as string[]).includes('sword'));

/** Плоская пластина-силуэт по профилю ширины: пята в y = 0, остриё в y = −len. */
function plate(len: number, widthAt: (u: number) => number, n = 40): THREE.Mesh {
  const pos: number[] = [];
  for (let i = 0; i < n; i++) {
    const u0 = i / n, u1 = (i + 1) / n;
    const a0 = widthAt(u0) / 2, a1 = widthAt(u1) / 2;
    const y0 = -len * u0, y1 = -len * u1;
    pos.push(-a0, y0, 0, a0, y0, 0, a1, y1, 0, -a0, y0, 0, a1, y1, 0, -a1, y1, 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return new THREE.Mesh(geo);
}

describe('bladeGeom — замер клинка', () => {
  it('прямоугольник: ЦТ 0.5, ширина та, что задана, расширения нет', () => {
    const m = measureBlade(plate(80, () => 5))!;
    expect(m.len).toBeCloseTo(80, 1);
    expect(m.width).toBeCloseTo(5, 2);
    expect(m.bal).toBeCloseTo(0.5, 2);
    expect(m.flare).toBeCloseTo(1, 2);
  });

  it('треугольник от гарды к острию: ЦТ ≈ 1/3 (вес у руки)', () => {
    const m = measureBlade(plate(90, (u) => 6 * (1 - u)))!;
    expect(m.bal).toBeGreaterThan(0.3);
    expect(m.bal).toBeLessThan(0.36);
  });

  it('расширение к концу (фальшион) читается как flare > 1.15 и ЦТ > 0.5', () => {
    const m = measureBlade(plate(75, (u) => (u < 0.9 ? 4 + 5 * u : 8.5 * (1 - u) * 10)))!;
    expect(m.flare).toBeGreaterThan(1.15);
    expect(m.bal).toBeGreaterThan(0.5);
  });

  it('низкополигональная модель (один длинный треугольник на полосу) не даёт нулевых сечений', () => {
    const m = measureBlade(plate(100, (u) => 5 * (1 - 0.5 * u), 3))!;
    expect(m.prof.every((w) => w > 0)).toBe(true);
    expect(m.warn).toEqual([]);
  });

  it('⭐ центр модели посередине клинка: пята и остриё различаются по форме, а не по началу координат', () => {
    const taper = (u: number): number => 6 - 5.5 * u;
    const ref = measureBlade(plate(80, taper))!;
    // Остриём вверх (+Y) и центром посередине — типичный экспорт: догадка «пята у начала координат» — монетка.
    const up = plate(80, taper);
    up.rotation.z = Math.PI;
    up.position.y = -40;
    const m = measureBlade(up, { orient: true })!;
    expect(m.bal).toBeCloseTo(ref.bal, 2);
    expect(m.flare).toBeCloseTo(ref.flare, 1);
    expect(m.warn.join(' ')).toMatch(/по форме/);
    // Ручной переворот ставит клинок задом наперёд — это видно по центру тяжести.
    const flipped = measureBlade(up, { orient: true, flip: true })!;
    expect(flipped.bal).toBeCloseTo(1 - ref.bal, 2);
  });

  it('модель не по договору (клинок по +X) разворачивается и меряется так же', () => {
    const lying = plate(80, () => 5);
    lying.rotation.z = Math.PI / 2; // −Y → +X
    const a = measureBlade(lying, { orient: true })!;
    expect(a.len).toBeCloseTo(80, 1);
    expect(a.width).toBeCloseTo(5, 2);
    expect(a.warn.length).toBeGreaterThan(0);
  });
});

describe('⭐ geom в данных = замер заглушки', () => {
  const write = process.env.DM_WRITE_BLADE_GEOM === '1';

  it('у каждого мечевого клинка есть geom, и он совпадает с замером', () => {
    const measured = new Map<string, ReturnType<typeof geomOf>>();
    for (const p of swordBlades) {
      const m = measurePart(p.id);
      expect(m, p.id).not.toBeNull();
      measured.set(p.id, geomOf(m!));
    }
    if (write) {
      writeGeom(measured);
      return;
    }
    const off: string[] = [];
    for (const p of swordBlades) {
      const m = measured.get(p.id)!, g = p.geom;
      if (!g) { off.push(`${p.id}: нет geom`); continue; }
      const bad = Math.abs(g.len - m.len) > 0.15 || Math.abs(g.width - m.width) > 0.02 || Math.abs(g.bal - m.bal) > 0.002 ||
        Math.abs((g.flare ?? 1) - m.flare) > 0.02 || Math.abs((g.spine ?? 0) - m.spine) > 0.05;
      if (bad) off.push(`${p.id}: в данных ${JSON.stringify(g)}, замер ${JSON.stringify(m)}`);
    }
    // Разошлось — перемерь: DM_WRITE_BLADE_GEOM=1 npx vitest run bladeGeom
    expect(off).toEqual([]);
  });
});

/** Вписывает `geom` в строки клинков, остальные строки файла не трогает. */
function writeGeom(measured: Map<string, ReturnType<typeof geomOf>>): void {
  const raw = readFileSync(PARTS_JSON, 'utf8');
  const nl = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(nl);
  const ser = (g: ReturnType<typeof geomOf>): string =>
    `{"len": ${g.len}, "width": ${g.width}, "bal": ${g.bal}, "flare": ${g.flare}, "spine": ${g.spine}}`;
  let touched = 0;
  const out = lines.map((line) => {
    const id = /"id": "([^"]+)"/.exec(line)?.[1];
    const g = id ? measured.get(id) : undefined;
    if (!g) return line;
    touched++;
    if (/"geom": \{[^}]*\}/.test(line)) return line.replace(/"geom": \{[^}]*\}/, `"geom": ${ser(g)}`);
    return line.replace(/("axis": -?[0-9.]+)/, `$1, "geom": ${ser(g)}`);
  });
  writeFileSync(PARTS_JSON, out.join(nl));
  expect(touched).toBe(measured.size);
}
