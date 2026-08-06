import { ATTRIBUTES, abilityCooldown, abilityRankMult, activeToggleInfos, deriveStats, effectiveLevel, finalAttributes, xpForLevel, debuffLabel, debuffIcon, weaponDebuffs, elementDebuffs, armorPoise, isDotKind, emptyPacket, PERCENT_STATS, type Attribute, type Attributes, type DamageType, type DerivedStats, type DebuffKind, type DebuffApply, type Item, type StatModifier } from '@dm/shared';
import type { App } from '../../core/app.js';
import type { Panel, PanelFactory } from '../../ui/domUi.js';
import { attackDamageByType } from '../combat/playerStats.js';
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
  title.innerHTML = `<b>Атрибуты</b> · нераспределённых очков: <b style="color:#dca94b">${state.save.unspentAttributePoints}</b>`;
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
      'width:26px;height:26px;cursor:pointer;background:#2b323f;color:#e6ddc9;border:1px solid #3e4756;border-radius:4px';
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
  box.style.cssText = 'margin-top:12px;font-size:13px;color:#c4bca8;line-height:1.6';
  box.innerHTML = `
    Уровень: <b style="color:#e6ddc9">${state.save.level}</b> ·
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

// Res-стат → стихия (маг. подтип). Имя/цвет берём из конфига `magic-subtypes`
// (единый источник, без задвоения хардкод-палитры).
const RES: [keyof DerivedStats, DamageType][] = [
  ['resFire', 'fire'],
  ['resCold', 'cold'],
  ['resLightning', 'lightning'],
  ['resPoison', 'poison'],
];

const DMG_TYPES: DamageType[] = ['physical', 'fire', 'cold', 'lightning', 'poison'];

function resRow(label: string, frac: number, color: string, tip?: string, labelW = 60): HTMLElement {
  const row = mk('div', 'display:flex;align-items:center;gap:8px;padding:3px 0;cursor:help');
  row.append(mk('span', `width:${labelW}px;font-size:13px;color:${COLORS.dim}`, label));
  const bar = mk('div', `flex:1;height:6px;background:${COLORS.panel};border-radius:999px;overflow:hidden`);
  const fill = mk('div', `height:100%;background:${color}`);
  fill.style.width = `${Math.max(0, Math.min(100, frac * 100))}%`;
  bar.append(fill);
  row.append(bar);
  row.append(mk('span', 'width:40px;text-align:right;font-size:13px;font-weight:500', `${Math.round(frac * 100)}%`));
  attachTooltip(row, () => tip ?? `Снижает урон стихии «${label}» на ${Math.round(frac * 100)}%. Максимум — 75%.`);
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
        ? deriveStats(previewBase, mods, state.derivedScalingProvider(), state.save.level, state.moveSpeedBaseProvider())
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
        right.append(mk('span', 'color:#e6ddc9', rightText ?? (showFrac ? `${Math.round(curV)} / ${Math.round(maxV)}` : `${Math.round(curV)}%`)));
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
      const stamReserved = Math.round(d.maxStamina * state.reservedStaminaFracProvider());
      bars.append(barLine('Выносливость', state.stamina, d.maxStamina, '#9aa63c', true, delta(d.maxStamina, pd.maxStamina),
        stamReserved > 0 ? `${Math.round(state.stamina)} / ${Math.round(d.maxStamina)} · резерв ${stamReserved}` : undefined));
      const xpInto = state.save.xp - cur;
      const xpNeed = next - cur;
      const xpText = next > cur ? `${xpInto} / ${xpNeed} · ${Math.round(pct * 100)}%` : 'макс. уровень';
      bars.append(barLine('Опыт', pct * 100, 100, '#639922', false, undefined, xpText));
      body.append(bars);

      // Активные ауры/стойки: что включено и что даёт (числовые бонусы уже учтены в статах ниже).
      const auras = activeToggleInfos(app.config, state.toggles);
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
        `Эффективный уровень персонажа = уровень + гир + мастерства.<br>` +
        `Уровень <b>${pw.level}</b> + гир <b>+${pw.gearBonus}</b> + мастерства <b>+${pw.passiveBonus}</b> = <b>${pw.total}</b>.<br>` +
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
            ? `Своя (с мастерствами): <b>${own}</b> · от гира: <b style="color:#6f9bcf">${gearBonus > 0 ? '+' : ''}${gearBonus}</b> = <b>${effAttrs[attr]}</b>`
            : `Своя (с мастерствами): <b>${own}</b>`;
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
      // Строки «урон по типам» из диапазонов {t:{min,max}} — общий вид для базовой атаки и скиллов.
      const typeLines = (bt: Record<DamageType, { min: number; max: number }>): string =>
        DMG_TYPES.filter((t) => bt[t].max > 0).map((t) =>
          `<span style="color:${dmgColor(t)}">■</span> ${dmgName(t)}: <b>${Math.round(bt[t].min)}–${Math.round(bt[t].max)}</b>`).join('<br>') || '—';
      const weaponTip = (): string => {
        const w = state.save.equipment.weapon;
        // Скейл задаёт вес оружия; тултип упрощён: магическое → Интеллект, иначе по типу атаки.
        const attrName = w?.damageKind === 'magical' ? 'Интеллекта' : (w?.attackType ?? 'melee') === 'ranged' ? 'Ловкости' : 'Силы';
        // Бонусы урона с гира/скиллов: %-множители по типам + плоские стихийные добавки.
        const pctRows: string[] = [];
        if (d.damagePct) pctRows.push(`весь урон +${Math.round(d.damagePct * 100)}%`);
        for (const [pk, t] of [['physPct', 'physical'], ['firePct', 'fire'], ['coldPct', 'cold'], ['lightningPct', 'lightning'], ['poisonPct', 'poison']] as [keyof DerivedStats, DamageType][]) {
          const v = d[pk] as number; if (v) pctRows.push(`<span style="color:${dmgColor(t)}">${dmgName(t)}</span> +${Math.round(v * 100)}%`);
        }
        const addRows: string[] = [];
        for (const [ak, t] of [['addFire', 'fire'], ['addCold', 'cold'], ['addLightning', 'lightning'], ['addPoison', 'poison']] as [keyof DerivedStats, DamageType][]) {
          const v = d[ak] as number; if (v) addRows.push(`<span style="color:${dmgColor(t)}">■</span> +${Math.round(v)} ${dmgName(t)}`);
        }
        const bonus = (pctRows.length || addRows.length)
          ? `<br><br><b>Бонусы урона:</b><br>${[...addRows, ...pctRows].join('<br>')}`
          : '';
        return `Урон базовой атаки по типам:<br>${typeLines(byType)}<br><br>` +
          `Тип базы — по оружию. Растёт от базы оружия и <b>${attrName}</b>; стихийные добавки — с аффиксов гира/скиллов.${bonus}`;
      };
      const skillTree = app.config.get('skill-tree');

      // ── Статусы, которые НАКЛАДЫВАЕТ атака (подтип оружия + стихия скилла), с ЭФФЕКТИВНЫМИ числами ──
      const physSubs = app.config.get('phys-subtypes');
      const dmgCfg = app.config.get('magic-subtypes');
      const debuffsCfg = app.config.get('debuffs');
      const kNum = (k: DebuffKind, suf: string): number => (d[`${k}${suf}` as keyof DerivedStats] as number) || 0;
      const strengthStr = (b: DebuffApply, pMul: number): string => {
        const pd = (b.magPerDamage ?? 0) * pMul * 100, m = b.mag * pMul * 100, m2 = (b.mag2 ?? 0) * pMul * 100;
        switch (b.kind) {
          case 'bleed': case 'burn': case 'poison': return `${pd.toFixed(1)}% урона/сек`;
          case 'wound': return `−${m.toFixed(0)}% урона · −${m2.toFixed(0)}% скор.`;
          case 'sunder': return `+${m.toFixed(0)}% получ. урона`;
          case 'daze': return `−${m.toFixed(0)}% брони · ${m2.toFixed(0)}% стан`;
          case 'shock': return `+${m.toFixed(0)}% получ. урона`;
          case 'freeze': return `−${m.toFixed(0)}% скор. · ${m2.toFixed(0)}% сковать`;
          default: return '';
        }
      };
      // Статусы удара по ИТОГОВОМУ составу (как в движке): базовый byType → конверсия скилла (доля урона → стихия) →
      // physSub только при наличии физ. урона → явный статус скилла (переопределяет авто) → авто стих-проки (дедуп).
      const attackAilments = (binding: string | null): DebuffApply[] => {
        const weapon = state.save.equipment.weapon;
        const node = (binding && binding !== 'attack') ? skillTree?.nodes.find((n) => n.id === binding) : undefined;
        const act = node?.effect.active;
        const el: DamageType = (node ? (elementOf(node) ?? 'physical') : 'physical') as DamageType;
        // Итоговый состав удара — тот же, что в разбивке урона: скилл через skillByType (scope-множитель +
        // добавка стихии + конверсия), базовая атака — byType. Статусы идут по стихиям этого пакета.
        const pkt = emptyPacket();
        if (act && (act.category === 'attack' || act.category === 'cast')) {
          const rank = state.save.skills[binding!] ?? 1;
          const sbt = skillByType(act, rank, el);
          for (const t of Object.keys(pkt) as DamageType[]) pkt[t] = sbt[t].max;
        } else {
          for (const t of Object.keys(pkt) as DamageType[]) pkt[t] = byType[t]?.max ?? 0;
        }
        // physSub — только если в ударе остался физ. урон (при полной конверсии гаснет).
        const out: DebuffApply[] = (weapon && pkt.physical > 0) ? [...weaponDebuffs(weapon, physSubs, debuffsCfg)] : [];
        // Явный статус скилла (переопределяет авто того же вида).
        if (act && 'ailment' in act && act.ailment) {
          const kind = (act.ailment.kind ?? dmgCfg.find((x) => x.id === el)?.ailment) as DebuffKind | undefined;
          if (kind) {
            const dot = isDotKind(kind);
            out.push({ kind, chance: act.ailment.chance, maxStacks: act.ailment.maxStacks, durationMs: act.ailment.durationMs, mag2: act.ailment.mag2, ...(dot ? { mag: 0, magPerDamage: act.ailment.mag } : { mag: act.ailment.mag }) });
          }
        }
        // Авто стих-проки по стихиям в ударе (дедуп: physSub/явный статус того же вида приоритетнее).
        const have = new Set<DebuffKind>(out.map((x) => x.kind));
        out.push(...elementDebuffs(pkt, dmgCfg, debuffsCfg).filter((x) => !have.has(x.kind)));
        return out;
      };
      const ailmentTip = (binding: string | null): string => {
        const lines = attackAilments(binding).map((b) => {
          const chance = Math.min(1, b.chance * (1 + d.ailmentPct + kNum(b.kind, 'ChancePct')));
          const durS = (b.durationMs * (1 + d.ailmentDurPct + kNum(b.kind, 'DurPct'))) / 1000;
          const pMul = 1 + d.ailmentPct + kNum(b.kind, 'PowerPct');
          return `${debuffIcon(debuffsCfg, b.kind)} <b>${debuffLabel(debuffsCfg, b.kind)}</b> — шанс ${Math.round(chance * 100)}% · ${durS.toFixed(1)}с · ${strengthStr(b, pMul)}${b.maxStacks > 1 ? ` (до ${b.maxStacks} стак.)` : ''}`;
        });
        const wsc = state.save.equipment.weapon?.stunChance;
        if (wsc) lines.push(`💥 <b>Стан</b> — ${Math.round(wsc * 100)}%`);
        return lines.length ? `<br><br><b>Накладывает:</b><br>${lines.join('<br>')}<br><span style="color:#8f897c;font-size:11px">(до сопротивления цели)</span>` : '';
      };

      // Разбивка урона скилла по типам (как в движке applySkillDamage): множитель по scope
      // (base — только баз. тип оружия / all — весь пакет) → добавка стихии (addElementPct) → конверсия (convertPct).
      const skillByType = (active: { damageMult: number; convertPct?: number; multScope?: 'base' | 'all'; addElementPct?: number }, rank: number, el: DamageType): Record<DamageType, { min: number; max: number }> => {
        const mult = active.damageMult * abilityRankMult(rank);
        const baseType = (state.save.equipment.weapon?.damageType ?? 'physical') as DamageType;
        const bt = {} as Record<DamageType, { min: number; max: number }>;
        for (const t of DMG_TYPES) bt[t] = { min: byType[t].min, max: byType[t].max };
        if ((active.multScope ?? 'base') === 'all') { for (const t of DMG_TYPES) { bt[t].min *= mult; bt[t].max *= mult; } }
        else { bt[baseType].min *= mult; bt[baseType].max *= mult; }
        const add = active.addElementPct ?? 0;
        if (add > 0) { bt[el].min += bt[baseType].min * add; bt[el].max += bt[baseType].max * add; }
        const conv = active.convertPct ?? 0;
        if (conv > 0) {
          let cMin = 0, cMax = 0;
          for (const t of DMG_TYPES) { cMin += bt[t].min * conv; cMax += bt[t].max * conv; bt[t].min *= (1 - conv); bt[t].max *= (1 - conv); }
          bt[el].min += cMin; bt[el].max += cMax;
        }
        return bt;
      };

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
          attachTooltip(row, () => weaponTip() + ailmentTip('attack'));
        } else if (binding) {
          const node = skillTree?.nodes.find((n) => n.id === binding);
          const active = node?.effect.active;
          if (node && active && (active.category === 'attack' || active.category === 'cast')) {
            const rank = state.save.skills[binding] ?? 1;
            const el = (elementOf(node) ?? 'physical') as DamageType;
            const sbt = skillByType(active, rank, el);   // итоговый урон по типам (scope-множитель + добавка + конверсия)
            let sMin = 0, sMax = 0;
            for (const t of DMG_TYPES) { sMin += sbt[t].min; sMax += sbt[t].max; }
            const sdmg = Math.round((sMin + sMax) / 2);
            // Атака — темп от скорости атаки; каст — каст-тайм от Интеллекта.
            const [sdps, rateTip] = active.category === 'attack'
              ? (() => { const r = Math.max(0.2, state.derived().attackSpeed * active.speed); return [Math.round(sdmg * r), `темп ${(1 / r).toFixed(2)} с/удар`] as const; })()
              : (() => { const ct = active.castTimeSec / Math.max(0.2, state.derived().castSpeed); return [ct > 0 ? Math.round(sdmg / ct) : sdmg, `каст ${ct.toFixed(2)} с`] as const; })();
            right.append(mk('span', `font-weight:600;color:${dmgColor(el)}`, `${sdmg} (ДПС ~${sdps})`));
            attachTooltip(row, () =>
              `${node.name}: урон <b>${sdmg}</b>, ${rateTip}, ДПС ~${sdps}. Мана ${active.manaCost}.<br><br>` +
              `Урон по типам:<br>${typeLines(sbt)}` +
              ailmentTip(binding));
          } else if (node && active) {
            // Проклятие/аура/стойка/бафф — прямого урона нет.
            const kind = active.category === 'curse' ? 'проклятие' : active.category === 'aura' ? 'аура' : active.category === 'stance' ? 'стойка' : 'бафф';
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
      // Хотбар (Shift/Space/Alt) — показываем назначенные.
      const HOTKEYS = ['Shift', 'Space', 'Alt'];
      state.save.hotbar.forEach((b, i) => { if (b) off.append(dmgRowFor(`Урон (${HOTKEYS[i]})`, b)); });

      off.append(statRow('Скор. атаки', `${d.attackSpeed.toFixed(2)} /с`, 'Число базовых атак в секунду.'));
      off.append(statRow('Шанс крита', `${Math.round(d.critChance * 100)}%`,
        `Вероятность нанести усиленный удар (×${d.critMultiplier.toFixed(2)}).`));
      off.append(statRow('Множ. крита', `×${d.critMultiplier.toFixed(2)}`,
        'Во сколько раз крит-удар сильнее обычного.'));
      off.append(statRow('Меткость', `${Math.round(d.accuracy)}${hitPct != null ? ` · ${hitPct}%` : ''}`,
        'Рейтинг атаки. Шанс попасть = меткость / (меткость + уклонение цели), 5–95%.' +
        (lt ? `<br>По «${lt.name}» (последний): <b>${hitPct}%</b> попасть.` : '<br>Атакуй монстра — покажу реальный шанс по нему.'),
        delta(d.accuracy, pd.accuracy)));
      off.append(statRow('Скор. каста', `×${d.castSpeed.toFixed(2)}`,
        'Множитель скорости каста: каст-тайм скиллов делится на неё. Растёт от Интеллекта.'));
      if (d.armorPen > 0) off.append(statRow('Пробой брони', `${Math.round(d.armorPen * 100)}%`,
        'Игнорирует эту долю брони цели при ударе.'));
      body.append(off);

      // Бонусы: наглядная сводка ВСЕГО, что дают гир + пассивы + мастерства + скиллы. Сверху — урон
      // ИТОГОВЫМ % по типам («со всем вместе»); ниже — ВСЕ прочие модификаторы (броня/скорость/резисты/
      // атрибуты/вампиризм/…), агрегированные из allModifiers и подписанные тем же словарём, что предметы.
      const bon = sheetPanel('Бонусы (прокачка + гир)');
      const perPct: Record<DamageType, number> = { physical: d.physPct, fire: d.firePct, cold: d.coldPct, lightning: d.lightningPct, poison: d.poisonPct };
      const addFlat: Record<DamageType, number> = { physical: 0, fire: d.addFire, cold: d.addCold, lightning: d.addLightning, poison: d.addPoison };
      let anyBon = false;
      if (d.damagePct) { bon.append(statRow('Весь урон', `+${Math.round(d.damagePct * 100)}%`, 'Множитель ко ВСЕМ типам урона (складывается с типовыми ниже).')); anyBon = true; }
      for (const t of DMG_TYPES) {
        const combined = d.damagePct + perPct[t];   // «со всем вместе» для этого типа
        const parts: string[] = [];
        if (combined) parts.push(`+${Math.round(combined * 100)}%`);
        if (addFlat[t]) parts.push(`+${Math.round(addFlat[t])} плоск.`);
        if (!parts.length) continue;
        anyBon = true;
        const row = statRow(dmgName(t), parts.join(' · '),
          `Итоговый бонус к урону «${dmgName(t)}»: общий +${Math.round(d.damagePct * 100)}% + типовой +${Math.round(perPct[t] * 100)}%${addFlat[t] ? ` · плоско +${Math.round(addFlat[t])}` : ''}.`);
        (row.firstElementChild as HTMLElement).style.color = dmgColor(t);
        bon.append(row);
      }
      // Прочие бонусы: агрегируем ВСЕ модификаторы (гир + деревья), кроме урона (он показан выше по типам).
      const DMG_MOD = new Set(['minDamage', 'maxDamage', 'damagePct', 'physPct', 'firePct', 'coldPct', 'lightningPct', 'poisonPct', 'addFire', 'addCold', 'addLightning', 'addPoison']);
      const agg = new Map<string, { stat: string; kind: StatModifier['kind']; value: number }>();
      for (const md of state.allModifiers()) {
        if (DMG_MOD.has(md.stat)) continue;
        const key = `${md.stat}|${md.kind}`;
        const e = agg.get(key);
        if (e) e.value += md.value; else agg.set(key, { stat: md.stat, kind: md.kind, value: md.value });
      }
      const catOf = (s: string): number =>
        /armor|evade|blockChance|interruptResist/.test(s) ? 0 :
        /^res/.test(s) ? 1 :
        /maxHp|hpRegen|maxMana|manaRegen|maxStamina|staminaRegen/.test(s) ? 2 :
        /strength|dexterity|intelligence|vitality/.test(s) ? 3 :
        /critChance|critMultiplier|accuracy|attackSpeed|castSpeed|moveSpeed/.test(s) ? 4 : 5;
      const rest = [...agg.values()].filter((e) => Math.abs(e.value) > 1e-9).sort((a, b) => catOf(a.stat) - catOf(b.stat) || a.stat.localeCompare(b.stat));
      const RESCOLOR: Record<string, string> = { resFire: dmgColor('fire'), resCold: dmgColor('cold'), resLightning: dmgColor('lightning'), resPoison: dmgColor('poison') };
      if (rest.length) {
        if (anyBon) bon.append(mk('div', `height:1px;background:${COLORS.border};margin:8px 0`));
        for (const e of rest) {
          const isPct = e.kind === 'increased' || PERCENT_STATS.has(e.stat);
          const val = isPct ? `+${Math.round(e.value * 100)}%` : `+${Number.isInteger(e.value) ? e.value : e.value.toFixed(2)}`;
          const row = statRow(STAT_LABEL[e.stat] ?? e.stat, val);
          if (RESCOLOR[e.stat]) (row.firstElementChild as HTMLElement).style.color = RESCOLOR[e.stat]!;
          bon.append(row);
        }
        anyBon = true;
      }
      if (!anyBon) bon.append(mk('div', `font-size:12px;color:${COLORS.dim};padding:3px 0`, 'нет бонусов от прокачки/гира'));
      body.append(bon);

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
        'Текущее / максимум маны для магических скиллов (и резерва аур).', delta(d.maxMana, pd.maxMana)));
      def.append(statRow('Выносливость', `${Math.round(state.stamina)} / ${Math.round(d.maxStamina)}`,
        'Текущее / максимум выносливости для боевых скиллов (и резерва стоек).', delta(d.maxStamina, pd.maxStamina)));
      def.append(statRow('Реген HP', `${d.hpRegen.toFixed(1)} /с`,
        `Восстанавливает ${d.hpRegen.toFixed(1)} HP каждую секунду.`,
        delta(d.hpRegen, pd.hpRegen, { digits: 1, suffix: ' /с' })));
      def.append(statRow('Реген маны', `${d.manaRegen.toFixed(1)} /с`,
        `Восстанавливает ${d.manaRegen.toFixed(1)} маны каждую секунду.`,
        delta(d.manaRegen, pd.manaRegen, { digits: 1, suffix: ' /с' })));
      def.append(statRow('Реген вынос.', `${d.staminaRegen.toFixed(1)} /с`,
        `Восстанавливает ${d.staminaRegen.toFixed(1)} выносливости каждую секунду.`,
        delta(d.staminaRegen, pd.staminaRegen, { digits: 1, suffix: ' /с' })));
      if (d.interruptResist > 0) def.append(statRow('Стойк. к прерыв.', `${Math.round(d.interruptResist * 100)}%`,
        'Шанс НЕ сбить замах тяжёлого удара при стане/ошеломлении цели.'));
      body.append(def);

      // Сопротивления: стихийные (снижают урон стихии) + выдержка к физ. статусам (из брони).
      const res = sheetPanel('Сопротивления');
      for (const [key, elem] of RES) res.append(resRow(dmgName(elem), d[key], dmgColor(elem)));
      // Выдержка (poise): снижает шанс И длительность физ-дебаффов, считается из надетой брони.
      const armorClasses = app.config.get('armor-classes');
      const gearItems = Object.values(state.save.equipment).filter((it): it is Item => !!it);
      res.append(mk('div', `font-size:11px;color:${COLORS.dim};margin:9px 0 3px;text-transform:uppercase;letter-spacing:.04em`, 'Стойкость к физ. статусам'));
      for (const k of ['wound', 'bleed', 'sunder', 'daze'] as DebuffKind[]) {
        const poise = armorPoise(gearItems, k, armorClasses);
        res.append(resRow(`${debuffIcon(debuffsCfg, k)} ${debuffLabel(debuffsCfg, k)}`, poise, '#b0a58c',
          `Выдержка от брони: снижает шанс И длительность статуса «${debuffLabel(debuffsCfg, k)}» на ${Math.round(poise * 100)}%. Максимум — 60%.`, 110));
      }
      body.append(res);

      // Статусы (наложение): глобальные + per-kind бонусы от пассивок/гира (ветки скиллов).
      const ail = sheetPanel('Статусы');
      ail.append(statRow('Все статусы', `шанс/сила +${Math.round(d.ailmentPct * 100)}%  ·  длит. +${Math.round(d.ailmentDurPct * 100)}%`,
        'Глобальные бонусы к наложению ВСЕХ статусов (шанс, сила, длительность). Складываются с бонусами по видам.'));
      for (const k of ['wound', 'bleed', 'sunder', 'daze', 'burn', 'poison', 'shock', 'freeze'] as DebuffKind[]) {
        const c = d[`${k}ChancePct` as keyof DerivedStats] as number;
        const p = d[`${k}PowerPct` as keyof DerivedStats] as number;
        const du = d[`${k}DurPct` as keyof DerivedStats] as number;
        if (!c && !p && !du) continue;
        const parts: string[] = [];
        if (c) parts.push(`шанс +${Math.round(c * 100)}%`);
        if (p) parts.push(`сила +${Math.round(p * 100)}%`);
        if (du) parts.push(`длит. +${Math.round(du * 100)}%`);
        ail.append(statRow(debuffLabel(debuffsCfg, k), parts.join('  ·  '), `Бонусы к наложению статуса «${debuffLabel(debuffsCfg, k)}» (ветки скиллов/гир).`));
      }
      body.append(ail);

      // Прочее.
      const misc = sheetPanel('Прочее');
      misc.append(statRow('Скор. движения', String(Math.round(d.moveSpeed)),
        `Итоговая скорость перемещения (база 120). Бонусы: ${d.moveSpeed >= 120 ? '+' : ''}${Math.round((d.moveSpeed / 120 - 1) * 100)}%.`));
      misc.append(statRow('Золото', String(state.save.gold), 'Валюта: магазин, кузница, дерево мастерства.'));
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
            ['passive', 'Дерево мастерства'],
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
