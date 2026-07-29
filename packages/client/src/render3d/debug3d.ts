/**
 * Дебаг-режим 3D-клиента (кнопка «DBG» + клавиша F3). При включении показывает:
 *  • коллизию — wireframe-боксы стен на ТЕХ ЖЕ позициях, что физ-статика `PhysWorld.buildStatic`
 *    (InstancedMesh = один дроукол на весь этаж);
 *  • инфо-панель — live-значения (FPS, tick, ping, коорд игрока, area/depth, кол-во монстров/пиров/дропов, seq).
 * Данные подаёт online3d каждый кадр. Выключение убирает и то, и другое.
 */
import * as THREE from 'three';
import { Cell, TILE, type Grid } from '@dm/shared';
import { WALL_H } from './env3d.js';

export interface Debug3d {
  toggle(v?: boolean): void;
  setFloor(grid: Grid): void;
  update(info: Record<string, string | number>): void;
  readonly on: boolean;
}

export function mountDebug(scene: THREE.Scene, root: HTMLElement): Debug3d {
  let on = false;
  const colGroup = new THREE.Group(); colGroup.visible = false; scene.add(colGroup);
  const geo = new THREE.BoxGeometry(TILE, WALL_H, TILE);
  const mat = new THREE.MeshBasicMaterial({ color: 0x35e08a, wireframe: true, transparent: true, opacity: 0.45 });
  let colMesh: THREE.InstancedMesh | null = null;

  const setFloor = (grid: Grid): void => {
    if (colMesh) { colGroup.remove(colMesh); colMesh.dispose(); colMesh = null; }
    let n = 0; for (const row of grid) for (const c of row) if (c === Cell.Wall) n++;
    if (!n) return;
    colMesh = new THREE.InstancedMesh(geo, mat, n);
    const m = new THREE.Matrix4(); let i = 0;
    for (let y = 0; y < grid.length; y++) { const row = grid[y]!; for (let x = 0; x < row.length; x++) if (row[x] === Cell.Wall) { m.setPosition(x * TILE + TILE / 2, WALL_H / 2, y * TILE + TILE / 2); colMesh.setMatrixAt(i++, m); } }
    colMesh.instanceMatrix.needsUpdate = true; colGroup.add(colMesh);
  };

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;left:12px;top:170px;z-index:70;display:none;background:rgba(8,10,16,0.82);' +
    'border:1px solid #35506a;border-radius:6px;padding:8px 10px;font:11px/1.5 monospace;color:#9fe0c0;white-space:pre;pointer-events:none';
  root.appendChild(panel);

  const btn = document.createElement('button');
  btn.textContent = 'DBG';
  btn.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:70;padding:4px 9px;background:#1c2130;color:#8f9bb0;' +
    'border:1px solid #39415a;border-radius:5px;cursor:pointer;font:11px monospace;pointer-events:auto';
  root.appendChild(btn);

  const toggle = (v?: boolean): void => {
    on = v ?? !on;
    colGroup.visible = on; panel.style.display = on ? 'block' : 'none';
    btn.style.background = on ? '#274032' : '#1c2130'; btn.style.color = on ? '#8adca0' : '#8f9bb0';
  };
  btn.addEventListener('click', () => toggle());
  addEventListener('keydown', (e) => { if (e.code === 'F3') { e.preventDefault(); toggle(); } });

  const update = (info: Record<string, string | number>): void => {
    if (!on) return;
    panel.textContent = Object.entries(info).map(([k, v]) => `${k.padEnd(9)} ${v}`).join('\n');
  };
  return { toggle, setFloor, update, get on() { return on; } };
}
