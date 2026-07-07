import { ATTRIBUTES, abilityCooldown, abilityRankMult, activeToggleInfos, deriveStats, effectiveLevel, finalAttributes, xpForLevel, type Attribute, type Attributes, type DamageType, type DerivedStats } from '@dm/shared';
import type { App } from '../../core/app.js';
import type { Panel, PanelFactory } from '../../ui/domUi.js';
import { attackDamageByType, estimateWeaponDamage } from '../combat/playerStats.js';
import { elementOf } from '../skills/skillIcon.js';
import { STAT_LABEL } from '../inventory/itemView.js';
import { dmgColor, dmgName } from '../../core/damageTypes.js';
import { renderPassiveTree } from '../skills-passive/treeView.js';
import { tabsBar, button, COLORS, mk, attachTooltip } from '../../ui/kit.js';

function commit(app: App): void {
  // Онлайн: сейв авторитетен на сервере; локально только перерисовать открытые окна.
  app.bus.emit('state:changed', {});
}

/** Блок распределения атрибутов: строка на атрибут + кнопка «+». */
function attributesBlock(app: App): HTMLElement {
  const state = app.state!;
  const box = document.createElement('div');
  const title = document.createElement('div');
  title.innerHTML = `<b>Атрибуты</b> · нераспределённых очков: <b style="color:#ffd24b">${state.save.unspentAttributePoints}</b>`;
  title.style.marginBottom = '8px';
  box.appendChild(title);

  for (const attr of ATTRIBUTES as Attribute[]) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;margin:4px 0';
    const label = document.createElement('span');
    label.style.width = '120px';
    label.textContent = `${STAT_LABEL[attr]}: ${state.save.attributes[attr]}`;
    const plus = document.createElement('button');
    plus.textContent = '+';
    plus.disabled = state.save.unspentAttributePoints <= 0;
    plus.style.cssText =
      'width:26px;height:26px;cursor:pointer;background:#2c2c3a;color:#e8e8f0;border:1px solid #3c3c4a;border-radius:4px';
    plus.addEventListener('click', () => {
      if (state.save.unspentAttributePoints > 0) app.sendCmd({ cmd: 'allocAttr', attr });
    });
    row.append(label, plus);
    box.appendChild(row);
  }
  return box;
}

/** Сводка производных статов. */
function derivedBlock(app: App): HTMLElement {
  const state = app.state!;
  const d = state.derived();
  const box = document.createElement('div');
  box.style.cssText = 'margin-top:12px;font-size:13px;color:#b8b8c8;line-height:1.6';
  box.innerHTML = `
    Уровень: <b style="color:#e8e8f0">${state.save.level}</b> ·
    Опыт: ${state.save.xp}<br>
    Урон: <b>${Math.round(d.minDamage)}–${Math.round(d.maxDamage)}</b> ·
    Броня: <b>${Math.round(d.armor)}</b> ·
    Крит: <b>${Math.round(d.critChance * 100)}%</b><br>
    HP: <b>${Math.round(d.maxHp)}</b> · Мана: <b>${Math.round(d.maxMana)}</b>`;
  return box;
}

// ── Лист персонажа (D2-стайл) ────────────────────────────────────────────────
function sheetPanel(title: string): HTMLElement {
  const p = mk('div',
    `background:${COLORS.panel2};border:0.5px solid ${COLORS.border};border-radius:8px;padding:10px 12px;margin-bottom:12px`);
  p.append(mk('h4', `font-size:13px;margin:0 0 8px;color:${COLORS.dim};font-weight:500`, title));
  return p;
}

const PREVIEW_GREEN = '#5fd15f';

function statRow(label: string, value: string, tip?: string, delta?: string): HTMLElement {
  const row = mk('div', 'display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:3px 0;cursor:help');
  row.append(mk('span', `color:${COLORS.dim}`, label));
  const right = mk('span', 'display:flex;align-items:center;gap:6px');
  right.append(mk('span', 'font-weight:500', value));
  if (delta) right.append(mk('span', `color:${PREVIEW_GREEN};font-weight:600;font-size:12px`, delta));
  row.append(right);
  if (tip) attachTooltip(row, () => tip);
  return row;
}

// Res-стат → стихия (тип урона). Имя/цвет берём из конфига `damage-types`
// (единый источник, без задвоения хардкод-палитры).
const RES: [keyof DerivedStats, DamageType][] = [
  ['resFire', 'fire'],
  ['resCold', 'cold'],
  ['resLightning', 'lightning'],
  ['resPoison', 'poison'],
];

const SKILL_AOE = /nova|shout|taunt|caltrops|berserk|wolf|horn|rally|blizzard|meteor|trap|rain|skin|wall/;
/** Типы активок, наносящих прямой урон (для превью «Наступление»). */
const ATTACK_SKILL_TYPES = new Set(['strike', 'cleave', 'nova', 'projectile', 'boomerang', 'dash']);
const DMG_TYPES: DamageType[] = ['physical', 'fire', 'cold', 'lightning', 'poison'];

function resRow(label: string, frac: number, color: string): HTMLElement {
  const row = mk('div', 'display:flex;align-items:center;gap:8px;padding:3px 0;cursor:help');
  row.append(mk('span', `width:60px;font-size:13px;color:${COLORS.dim}`, label));
  const bar = mk('div', `flex:1;height:6px;background:${COLORS.panel};border-radius:999px;overflow:hidden`);
  const fill = mk('div', `height:100%;background:${color}`);
  fill.style.width = `${Math.max(0, Math.min(100, frac * 100))}%`;
  bar.append(fill);
  row.append(bar);
  row.append(mk('span', 'width:40px;text-align:right;font-size:13px;font-weight:500', `${Math.round(frac * 100)}%`));
  attachTooltip(row, () =>
    `Снижает урон стихии «${label}» на ${Math.round(frac * 100)}%. Максимум — 75%.`);
  return row;
}

/** Полный лист персонажа (клавиша C): атрибуты, наступление, защита, сопротивления. */
export const characterPanel: PanelFactory = (app, ui) => {
  // Буфер незакоммиченного распределения атрибутов (переживает перерисовки окна,
  // т.к. фабрика вызывается один раз на открытие). Клики «+/−» только набирают
  // буфер, OK применяет, Отмена сбрасывает.
  const pending: Record<Attribute, number> = { strength: 0, dexterity: 0, intelligence: 0, vitality: 0 };
  const resetPending = (): void => { for (const a of ATTRIBUTES as Attribute[]) pending[a] = 0; };

  return {
    title: 'Персонаж',
    render(body) {
      const state = app.state!;
      const d = state.derived();
      const cls = app.config.get('classes').find((c) => c.id === state.save.classId);

      // Реальные шансы попасть/увернуться по последнему атакованному монстру.
      const lt = app.lastTarget;
      const clampChance = (v: number): number => Math.max(0.05, Math.min(0.95, v));
      const hitPct = lt ? Math.round(clampChance(d.accuracy / (d.accuracy + lt.evade)) * 100) : null;
      const dodgePct = lt ? Math.round((1 - clampChance(lt.accuracy / (lt.accuracy + d.evade))) * 100) : null;

      // Превью: набранное в буфер + производные статы с учётом буфера.
      const staged = (ATTRIBUTES as Attribute[]).reduce((s, a) => s + pending[a], 0);
      const remaining = state.save.unspentAttributePoints - staged;
      const mods = state.allModifiers();
      const previewBase = { ...state.save.attributes } as Attributes;
      for (const a of ATTRIBUTES as Attribute[]) previewBase[a] += pending[a];
      const pd = staged > 0
        ? deriveStats(previewBase, mods, state.derivedScalingProvider(), state.save.level)
        : d;

      // Зелёный «+Δ» если стат вырос (иначе undefined → ничего не показываем).
      const delta = (curV: number, prevV: number, opts: { digits?: number; pct?: boolean; suffix?: string } = {}): string | undefined => {
        const { digits = 0, pct = false, suffix = '' } = opts;
        const diff = prevV - curV;
        const eps = pct ? 0.005 : digits > 0 ? 0.05 : 0.5;
        if (diff <= eps) return undefined;
        const shown = pct ? `${Math.round(diff * 100)}%` : digits > 0 ? diff.toFixed(digits) : String(Math.round(diff));
        return `+${shown}${suffix}`;
      };

      // Шапка + опыт.
      const head = mk('div', 'margin-bottom:6px');
      head.innerHTML =
        `<div style="font-size:18px;font-weight:500">${state.save.name}</div>` +
        `<div style="font-size:12px;color:${COLORS.dim}">${cls?.name ?? state.save.classId} · Уровень ${state.save.level}</div>`;
      body.append(head);

      // Полосы ресурсов в шапке: HP, мана, опыт — с числами и превью-дельтой.
      const barLine = (label: string, curV: number, maxV: number, color: string, showFrac: boolean, deltaStr?: string, rightText?: string): HTMLElement => {
        const wrap = mk('div', 'margin:6px 0');
        const top = mk('div', `display:flex;justify-content:space-between;font-size:11px;color:${COLORS.dim};margin-bottom:2px`);
        const right = mk('span', 'display:flex;gap:6px');
        right.append(mk('span', 'color:#e8e8f0', rightText ?? (showFrac ? `${Math.round(curV)} / ${Math.round(maxV)}` : `${Math.round(curV)}%`)));
        if (deltaStr) right.append(mk('span', `color:${PREVIEW_GREEN};font-weight:600`, deltaStr));
        top.append(mk('span', '', label), right);
        const bar = mk('div', `height:8px;background:${COLORS.panel2};border-radius:999px;overflow:hidden`);
        const fill = mk('div', `height:100%;background:${color}`);
        fill.style.width = `${Math.max(0, Math.min(100, (maxV > 0 ? curV / maxV : 0) * 100))}%`;
        bar.append(fill);
        wrap.append(top, bar);
        return wrap;
      };

      const xpTable = app.config.get('balance').xpTable;
      const cur = xpForLevel(state.save.level, xpTable);
      const next = xpForLevel(state.save.level + 1, xpTable);
      const pct = next > cur ? (state.save.xp - cur) / (next - cur) : 1;

      const bars = mk('div', 'margin:6px 0 14px');
      bars.append(barLine('Здоровье', state.hp, d.maxHp, '#cf4b4b', true, delta(d.maxHp, pd.maxHp)));
      const manaReserved = Math.round(d.maxMana * state.reservedManaFracProvider());
      bars.append(barLine('Мана', state.mana, d.maxMana, '#4b7bcf', true, delta(d.maxMana, pd.maxMana),
        manaReserved > 0 ? `${Math.round(state.mana)} / ${Math.round(d.maxMana)} · резерв ${manaReserved}` : undefined));
      const xpInto = state.save.xp - cur;
      const xpNeed = next - cur;
      const xpText = next > cur ? `${xpInto} / ${xpNeed} · ${Math.round(pct * 100)}%` : 'макс. уровень';
      bars.append(barLine('Опыт', pct * 100, 100, '#639922', false, undefined, xpText));
      body.append(bars);

      // Активные ауры/стойки: что включено и что даёт (числовые бонусы уже учтены в статах ниже).
      const auras = activeToggleInfos(app.config, state.save.classId, state.toggles);
      if (auras.length) {
        const box = mk('div', `background:${COLORS.panel2};border:0.5px solid ${COLORS.border};border-radius:8px;padding:8px 10px;margin:0 0 12px`);
        box.append(mk('div', `font-size:12px;color:${COLORS.dim};margin-bottom:4px`, 'Активные ауры/стойки'));
        for (const a of auras) {
          const row = mk('div', 'font-size:12px;margin:2px 0;line-height:1.4');
          row.innerHTML =
            `<b style="color:#8fb8ff">${a.name}</b>` +
            (a.reservePct > 0 ? ` <span style="color:${COLORS.dim}">· резерв ${Math.round(a.reservePct * 100)}% маны</span>` : '') +
            `<br><span style="color:${COLORS.dim}">${a.description}</span>`;
          box.append(row);
        }
        body.append(box);
      }

      // Мощь (эфф. уровень) — определяет стартовую сложность забега.
      const pw = effectiveLevel(state.save, app.config.get('balance').power);
      const powRow = mk('div', 'display:flex;justify-content:space-between;align-items:center;font-size:13px;margin:0 0 12px;cursor:help');
      powRow.append(mk('span', `color:${COLORS.dim}`, 'Мощь (эфф. уровень)'));
      powRow.append(mk('span', `font-weight:700;color:${COLORS.gold}`, String(pw.total)));
      attachTooltip(powRow, () =>
        `Эффективный уровень персонажа = уровень + гир + пассивы.<br>` +
        `Уровень <b>${pw.level}</b> + гир <b>+${pw.gearBonus}</b> + пассивы <b>+${pw.passiveBonus}</b> = <b>${pw.total}</b>.<br>` +
        `Задаёт стартовую сложность подземелья при выборе тира.`);
      body.append(powRow);

      const mitig = Math.round((d.armor / (d.armor + 30 + 5 * state.save.level)) * 100);

      // Атрибуты (со стадированием: клики набирают буфер, OK применяет).
      const attrs = sheetPanel(`Атрибуты · очков: ${remaining}`);
      const btnCss = `width:20px;height:20px;border-radius:4px;border:0.5px solid ${COLORS.borderHi};background:${COLORS.panel};color:${COLORS.text};font-size:13px;line-height:1;cursor:pointer`;
      // Итог (эфф.) и «своя» часть (база + пассивы + мастерства). Разница — вклад гира,
      // который исчезнет, если снять экипировку.
      const effAttrs = state.effectiveAttributes();
      const ownAttrs = state.permanentAttributes();
      const attrRowStaged = (attr: Attribute, tip: string): HTMLElement => {
        const row = mk('div', 'display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:3px 0;cursor:help');
        row.append(mk('span', `color:${COLORS.dim}`, STAT_LABEL[attr] ?? attr));
        const own = ownAttrs[attr];              // навсегда: база + пассивы + мастерства
        const gearBonus = effAttrs[attr] - own;  // от гира (снимается вместе с ним)
        // Тултип раскрывает состав: сколько своя (останется без гира), сколько даёт гир.
        attachTooltip(row, () => {
          const split = gearBonus !== 0
            ? `Своя (с пассивами): <b>${own}</b> · от гира: <b style="color:#7cc4ff">${gearBonus > 0 ? '+' : ''}${gearBonus}</b> = <b>${effAttrs[attr]}</b>`
            : `Своя (с пассивами): <b>${own}</b>`;
          return `${split}<br>${tip}`;
        });
        const right = mk('span', 'display:flex;align-items:center;gap:8px');
        // Главное число — итог (база + гир/пассивы); разбивка — в тултипе.
        right.append(mk('span', 'font-weight:600', String(effAttrs[attr])));
        if (pending[attr] > 0) right.append(mk('span', `color:${PREVIEW_GREEN};font-weight:600;font-size:12px`, `+${pending[attr]}`));
        const minus = mk('button', btnCss, '−');
        minus.disabled = pending[attr] <= 0;
        if (minus.disabled) minus.style.opacity = '0.4';
        minus.addEventListener('click', () => { if (pending[attr] > 0) { pending[attr] -= 1; ui.refresh(); } });
        const plus = mk('button', btnCss, '+');
        plus.disabled = remaining <= 0;
        if (plus.disabled) plus.style.opacity = '0.4';
        plus.addEventListener('click', () => { if (remaining > 0) { pending[attr] += 1; ui.refresh(); } });
        right.append(minus, plus);
        row.append(right);
        return row;
      };
      attrs.append(attrRowStaged('strength', 'Урон ближним оружием и требования по силе для экипировки.'));
      attrs.append(attrRowStaged('dexterity', 'Урон дальним оружием, меткость и уклонение.'));
      attrs.append(attrRowStaged('intelligence', 'Урон магией, максимум маны и реген маны.'));
      attrs.append(attrRowStaged('vitality', 'Максимум здоровья и реген HP.'));
      if (staged > 0) {
        const actions = mk('div', 'display:flex;gap:8px;margin-top:10px');
        actions.append(button(`OK — применить (${staged})`, () => {
          // Онлайн: по команде на каждое очко; сервер исполнит и вернёт SaveUpdate.
          for (const a of ATTRIBUTES as Attribute[]) {
            for (let k = 0; k < pending[a]; k++) app.sendCmd({ cmd: 'allocAttr', attr: a });
          }
          resetPending();
        }, 'primary'));
        actions.append(button('Отмена', () => { resetPending(); ui.refresh(); }, 'default'));
        attrs.append(actions);
      }
      body.append(attrs);

      // Наступление.
      const off = sheetPanel('Наступление');

      // Единая строка «Урон»: суммарный диапазон по всем типам, цвет — по преобладающему
      // типу, разбивка по типам — в тултипе. Тип базы берётся из надетого оружия
      // (у жезла огня — огонь, у меча — физ.), плюс стихийные добавки с гира/скиллов.
      const scaling = app.config.get('balance').weaponAttrScaling;
      const weights = app.config.get('weapon-weights');
      const byType = attackDamageByType(state, scaling, weights);
      const prevByType = staged > 0 ? attackDamageByType(state, scaling, weights, finalAttributes(previewBase, mods)) : byType;
      let dmgMin = 0, dmgMax = 0, pDmgMin = 0, pDmgMax = 0, dom: DamageType = 'physical', domAvg = -1;
      for (const t of DMG_TYPES) {
        dmgMin += byType[t].min; dmgMax += byType[t].max;
        pDmgMin += prevByType[t].min; pDmgMax += prevByType[t].max;
        const avg = (byType[t].min + byType[t].max) / 2;
        if (avg > domAvg) { domAvg = avg; dom = t; }
      }
      const domColor = dmgColor(dom);
      const atkDps = Math.round(((dmgMin + dmgMax) / 2) * d.attackSpeed);
      const dMinInc = Math.round(pDmgMin) - Math.round(dmgMin);
      const dMaxInc = Math.round(pDmgMax) - Math.round(dmgMax);
      const weaponTip = (): string => {
        const parts = DMG_TYPES.filter((t) => byType[t].max > 0).map((t) =>
          `<span style="color:${dmgColor(t)}">■</span> ${dmgName(t)}: <b>${Math.round(byType[t].min)}–${Math.round(byType[t].max)}</b>`);
        const wt = state.save.equipment.weapon?.weaponType ?? 'melee';
        const attrName = wt === 'melee' ? 'Силы' : wt === 'ranged' ? 'Ловкости' : 'Интеллекта';
        return `Урон базовой атаки по типам:<br>${parts.join('<br>') || '—'}<br><br>` +
          `Тип базы — по оружию. Растёт от базы оружия и <b>${attrName}</b>; стихийные добавки — с аффиксов гира/скиллов.`;
      };
      const skillTree = app.config.get('skills-active').find((t) => t.classId === state.save.classId);

      // Два урона (как D2): что назначено на ЛКМ и на ПКМ (атака оружием / скилл).
      const dmgRowFor = (label: string, binding: string | null): HTMLElement => {
        const row = mk('div', 'display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:3px 0;cursor:help');
        row.append(mk('span', `color:${COLORS.dim}`, label));
        const right = mk('span', 'display:flex;align-items:center;gap:6px');
        if (binding === 'attack') {
          right.append(mk('span', `font-weight:600;color:${domColor}`, `${Math.round(dmgMin)}–${Math.round(dmgMax)} (ДПС ~${atkDps})`));
          if (dMaxInc > 0 || dMinInc > 0) {
            const dd = dMinInc === dMaxInc ? `+${dMaxInc}` : `+${dMinInc}–${dMaxInc}`;
            right.append(mk('span', `color:${PREVIEW_GREEN};font-weight:600;font-size:12px`, dd));
          }
          attachTooltip(row, weaponTip);
        } else if (binding) {
          const node = skillTree?.nodes.find((n) => n.id === binding);
          const active = node?.effect.active;
          const isAttack = !!active && (!active.type || ATTACK_SKILL_TYPES.has(active.type));
          if (node && active && isAttack) {
            const rank = state.save.activeSkills[binding] ?? 1;
            const base = estimateWeaponDamage(state, state.save.equipment.weapon, scaling, weights);
            const typed = !!active.type;
            const mult = typed ? (active.damageMult ?? 1) : (SKILL_AOE.test(active.abilityId) ? 1.5 : 1.4);
            const sdmg = Math.round(base * mult * abilityRankMult(rank));
            let sdps: number; let rateTip: string;
            if (typed) {
              const rate = Math.max(0.2, state.derived().attackSpeed * (active.speed ?? 1));
              sdps = Math.round(sdmg * rate);
              rateTip = `темп ${(1 / rate).toFixed(2)} с/удар`;
            } else {
              const cd = abilityCooldown(active.cooldown, rank);
              sdps = cd > 0 ? Math.round(sdmg / cd) : sdmg;
              rateTip = `КД ${cd.toFixed(2)} с`;
            }
            const col = dmgColor(elementOf(node) as DamageType);
            right.append(mk('span', `font-weight:600;color:${col}`, `${sdmg} (ДПС ~${sdps})`));
            attachTooltip(row, () => `${node.name}: урон за удар <b>${sdmg}</b>, ${rateTip}, ДПС ~${sdps}. Мана ${active.manaCost}.`);
          } else if (node && active) {
            // Тогл/бафф/провокация — прямого урона нет.
            const kind = active.type === 'toggle' ? 'стойка/аура' : active.type === 'buff' ? 'бафф' : 'утилити';
            right.append(mk('span', `color:${COLORS.dim}`, '—'));
            attachTooltip(row, () => `${node.name}: ${kind} — без прямого урона.`);
          } else {
            right.append(mk('span', `color:${COLORS.dim}`, '—'));
          }
        } else {
          right.append(mk('span', `color:${COLORS.dim}`, 'не назначено'));
        }
        row.append(right);
        return row;
      };
      off.append(dmgRowFor('Урон (ЛКМ)', state.save.mouseLeft));
      off.append(dmgRowFor('Урон (ПКМ)', state.save.mouseRight));

      off.append(statRow('Скор. атаки', `${d.attackSpeed.toFixed(2)} /с`, 'Число базовых атак в секунду.'));
      off.append(statRow('Шанс крита', `${Math.round(d.critChance * 100)}%`,
        `Вероятность нанести усиленный удар (×${d.critMultiplier.toFixed(2)}).`));
      off.append(statRow('Множ. крита', `×${d.critMultiplier.toFixed(2)}`,
        'Во сколько раз крит-удар сильнее обычного.'));
      off.append(statRow('Меткость', `${Math.round(d.accuracy)}${hitPct != null ? ` · ${hitPct}%` : ''}`,
        'Рейтинг атаки. Шанс попасть = меткость / (меткость + уклонение цели), 5–95%.' +
        (lt ? `<br>По «${lt.name}» (последний): <b>${hitPct}%</b> попасть.` : '<br>Атакуй монстра — покажу реальный шанс по нему.'),
        delta(d.accuracy, pd.accuracy)));
      body.append(off);

      // Защита.
      const def = sheetPanel('Защита');
      def.append(statRow('Броня', String(Math.round(d.armor)),
        `Снижает получаемый физический урон. Сейчас: −${mitig}% (armor/(armor+30+5×ур.атакующего)).`));
      def.append(statRow('Уклонение', `${Math.round(d.evade)}${dodgePct != null ? ` · ${dodgePct}%` : ''}`,
        'Рейтинг защиты. Снижает шанс врага попасть по тебе (сравнивается с его меткостью).' +
        (lt ? `<br>От «${lt.name}» (последний): <b>${dodgePct}%</b> увернуться.` : '<br>Атакуй монстра — покажу реальный шанс уклонения от него.'),
        delta(d.evade, pd.evade)));
      def.append(statRow('Блок', `${Math.round(d.blockChance * 100)}%`,
        'Шанс полностью погасить удар (только от оружия/щита). Максимум 75%.'));
      def.append(statRow('Здоровье', `${Math.round(state.hp)} / ${Math.round(d.maxHp)}`,
        'Текущее / максимум HP. При 0 — смерть.', delta(d.maxHp, pd.maxHp)));
      def.append(statRow('Мана', `${Math.round(state.mana)} / ${Math.round(d.maxMana)}`,
        'Текущее / максимум маны для активных скиллов.', delta(d.maxMana, pd.maxMana)));
      def.append(statRow('Реген HP', `${d.hpRegen.toFixed(1)} /с`,
        `Восстанавливает ${d.hpRegen.toFixed(1)} HP каждую секунду.`,
        delta(d.hpRegen, pd.hpRegen, { digits: 1, suffix: ' /с' })));
      def.append(statRow('Реген маны', `${d.manaRegen.toFixed(1)} /с`,
        `Восстанавливает ${d.manaRegen.toFixed(1)} маны каждую секунду.`,
        delta(d.manaRegen, pd.manaRegen, { digits: 1, suffix: ' /с' })));
      body.append(def);

      // Сопротивления.
      const res = sheetPanel('Сопротивления');
      for (const [key, elem] of RES) res.append(resRow(dmgName(elem), d[key], dmgColor(elem)));
      body.append(res);

      // Прочее.
      const misc = sheetPanel('Прочее');
      misc.append(statRow('Скор. движения', String(Math.round(d.moveSpeed)),
        `Итоговая скорость перемещения (база 120). Бонусы: ${d.moveSpeed >= 120 ? '+' : ''}${Math.round((d.moveSpeed / 120 - 1) * 100)}%.`));
      misc.append(statRow('Золото', String(state.save.gold), 'Валюта: магазин, кузница, пассивные скиллы.'));
      misc.append(statRow('Макс. глубина', String(state.save.maxDepth), 'Самый глубокий достигнутый этаж.'));
      body.append(misc);
    },
  };
};

function attributesTab(app: App, body: HTMLElement): void {
  body.appendChild(attributesBlock(app));
  body.appendChild(derivedBlock(app));

  const respecCost = app.config.get('balance').respecCost;
  const state = app.state!;
  const respec = button(
    `Сбросить атрибуты (${respecCost} золота)`,
    () => { if (state.save.gold >= respecCost) app.sendCmd({ cmd: 'respec' }); },
    'default',
    state.save.gold < respecCost,
  );
  respec.style.marginTop = '14px';
  body.appendChild(respec);
}

/**
 * Мастер прокачки: единственное место прокачки пассивного дерева (за золото) +
 * распределение/сброс атрибутов. Активные скиллы — отдельное окно (клавиша K).
 */
export const masterPanel: PanelFactory = (app) => {
  let tab: 'passive' | 'attributes' = 'passive';
  const panel: Panel = {
    title: 'Мастер прокачки',
    render(body) {
      body.appendChild(
        tabsBar(
          [
            ['passive', 'Пассивное дерево'],
            ['attributes', 'Атрибуты'],
          ] as const,
          tab,
          (key) => { tab = key; app.bus.emit('state:changed', {}); },
        ),
      );
      if (tab === 'passive') renderPassiveTree(app, body);
      else attributesTab(app, body);
    },
  };
  return panel;
};
