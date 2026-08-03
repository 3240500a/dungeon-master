/**
 * DOM-HUD 3D-клиента (паритет с 2D UIScene): полосы HP/маны/выносливости/опыта с ЧИСЛАМИ и ЗОНАМИ
 * РЕЗЕРВА (ауры/стойки), строка «ур. · область · золото · очки», индикаторы дебаффов и активных
 * аур/стоек (◈). Переиспользует элементы `game3d.html` (#hp/#mana/#stam/#xp/#info); числа/резервы/
 * индикаторы досоздаёт в DOM. Читает `app.state` (авторитетный с сервера через online3d).
 */
import type { App } from '../core/app.js';
import { effectiveLevel, startChallenge, challengeAtFloor, activeToggleInfos, debuffIcon, debuffLabel, type DebuffKind } from '@dm/shared';

export interface Hud3d { update(): void; }

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** Цвет рамки бейджа статус-эффекта по виду (физические — тёплые, стихийные — по стихии). */
const DEBUFF_COLOR: Record<DebuffKind, string> = {
  wound: '#c86a5a', bleed: '#d8583e', sunder: '#c0956a', daze: '#c9b46a',
  burn: '#ff7a2a', poison: '#6ecb3f', shock: '#ffe24a', freeze: '#59a8ff',
};

export function mountHud3d(app: App): Hud3d {
  const g = (id: string): HTMLElement | null => document.getElementById(id);
  const hp = g('hp'), mana = g('mana'), stam = g('stam'), xp = g('xp'), info = g('info');

  // Центрированный текст-оверлей поверх дорожки (число X/Y). Дорожка → relative, заливка над резервом.
  const overlayText = (fill: HTMLElement | null): HTMLElement | null => {
    const track = fill?.parentElement; if (!track) return null;
    track.style.position = 'relative';
    fill.style.position = 'relative'; fill.style.zIndex = '1';
    const t = document.createElement('div');
    t.style.cssText = 'position:absolute;inset:0;z-index:2;display:flex;align-items:center;justify-content:center;' +
      'font:10px system-ui,sans-serif;color:#f2ede1;text-shadow:0 1px 2px #000;pointer-events:none;white-space:nowrap';
    track.appendChild(t); return t;
  };
  // Зона резерва (приглушённая доля справа — недоступная из-за аур/стоек), под заливкой.
  const reserveZone = (fill: HTMLElement | null, color: string): HTMLElement | null => {
    const track = fill?.parentElement; if (!track) return null;
    const r = document.createElement('div');
    r.style.cssText = `position:absolute;top:0;right:0;height:100%;width:0;z-index:0;background:${color};opacity:0.9`;
    track.appendChild(r); return r;
  };
  const hpText = overlayText(hp);
  const manaReserve = reserveZone(mana, '#2a3550'), manaText = overlayText(mana);
  const stamReserve = reserveZone(stam, '#39381f'), stamText = overlayText(stam);

  // Индикаторы игрока под инфо-строкой: дебаффы (иконка+стаки) и активные ауры/стойки (◈).
  const mkLine = (top: number, css: string): HTMLElement => {
    const d = document.createElement('div');
    d.style.cssText = `position:fixed;left:16px;top:${top}px;z-index:10;text-shadow:0 1px 2px #000;pointer-events:none;${css}`;
    document.body.appendChild(d); return d;
  };
  // Полоска статус-эффектов игрока: бейдж иконка+стаки+рамка по типу, тултип с названием (все 8 видов).
  const statusStrip = document.createElement('div');
  statusStrip.style.cssText = 'position:fixed;left:16px;top:112px;z-index:11;display:flex;gap:4px;pointer-events:auto';
  document.body.appendChild(statusStrip);
  let statusSig = '';
  const auraLine = mkLine(146, 'font-size:13px;color:#e39a3c');

  const bar = (node: HTMLElement | null, cur: number, max: number): void => { if (node) node.style.width = `${clamp01(cur / Math.max(1, max)) * 100}%`; };

  return {
    update(): void {
      const st = app.state; if (!st) return;
      const d = st.derived();
      const rMana = st.reservedManaFracProvider(), rStam = st.reservedStaminaFracProvider();
      // Полосы: заливка от полного максимума, справа — зона резерва (как 2D drawManaBar/drawStaminaBar).
      bar(hp, st.hp, d.maxHp); bar(mana, st.mana, d.maxMana); bar(stam, st.stamina, d.maxStamina);
      if (manaReserve) manaReserve.style.width = `${clamp01(rMana) * 100}%`;
      if (stamReserve) stamReserve.style.width = `${clamp01(rStam) * 100}%`;
      // xpTable кумулятивна: порог ТЕКУЩЕГО уровня = xt[lvl], следующего = xt[lvl+1] (на максимуме — полный бар).
      const xt = app.config.get('balance').xpTable; const lvl = st.save.level;
      const curXp = xt[lvl] ?? 0, nxXp = xt[lvl + 1] ?? curXp + 1;
      bar(xp, st.save.xp - curXp, Math.max(1, nxXp - curXp));

      // Числа на полосах.
      const reserved = Math.round(d.maxMana * rMana);
      if (hpText) hpText.textContent = `${Math.round(st.hp)} / ${Math.round(d.maxHp)}`;
      if (manaText) manaText.textContent = reserved > 0
        ? `${Math.round(st.mana)} / ${Math.round(d.maxMana)} (−${reserved})`
        : `${Math.round(st.mana)} / ${Math.round(d.maxMana)}`;
      if (stamText) stamText.textContent = `${Math.round(st.stamina)} / ${Math.round(d.maxStamina)}`;

      // Инфо-строка: уровень · область (город / этаж·сложность·вызов) · золото · очки.
      // Город/подземелье — по area, НЕ по depth (у старта забега depth=0, как у города). Этаж = depth+1 (старт = «этаж 1»).
      let loc = 'город';
      if (st.area === 'dungeon') {
        const diffs = app.config.get('difficulties');
        const diff = diffs.find((x) => x.id === st.difficultyId) ?? diffs.find((x) => x.id === 'normal') ?? diffs[0]!;
        const elv = effectiveLevel(st.save, app.config.get('balance').power).total;
        const cl = challengeAtFloor(startChallenge(elv, diff), diff, st.depth);
        loc = `этаж ${st.depth + 1} · ${diff.name} · вызов ур.${cl}`;
      }
      if (info) info.textContent = `Ур. ${lvl}  ·  ${loc}  ·  Золото ${st.save.gold}  ·  Очки: атр ${st.save.unspentAttributePoints} / скилл ${st.save.unspentSkillPoints}`;

      // Статус-эффекты игрока: пересобрать бейджи при изменении набора/стаков (не каждый кадр).
      const active = (Object.keys(st.debuffs) as DebuffKind[]).filter((k) => st.debuffs[k]);
      const sig = active.map((k) => `${k}${st.debuffs[k]!.stacks}`).join(',');
      if (sig !== statusSig) {
        statusSig = sig; statusStrip.innerHTML = '';
        const debuffsCfg = app.config.get('debuffs');
        for (const k of active) {
          const d = st.debuffs[k]!;
          const b = document.createElement('div');
          b.title = `${debuffLabel(debuffsCfg, k)}${d.stacks > 1 ? ` ×${d.stacks}` : ''}`;
          b.style.cssText = `position:relative;width:34px;height:34px;border:2px solid ${DEBUFF_COLOR[k]};border-radius:7px;` +
            'background:rgba(12,14,20,0.72);display:flex;align-items:center;justify-content:center;font-size:21px;line-height:1;text-shadow:0 1px 2px #000';
          b.textContent = debuffIcon(debuffsCfg, k);
          if (d.stacks > 1) { const s = document.createElement('span'); s.textContent = String(d.stacks); s.style.cssText = 'position:absolute;right:-3px;bottom:-4px;font:800 14px system-ui;color:#fff;text-shadow:0 1px 2px #000,0 0 3px #000,0 0 5px #000'; b.appendChild(s); }
          statusStrip.appendChild(b);
        }
      }
      const auras = activeToggleInfos(app.config, st.toggles);
      auraLine.textContent = auras.length ? '◈ ' + auras.map((a) => a.name).join('   ◈ ') : '';
    },
  };
}
