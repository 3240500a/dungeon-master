import { abilityCooldown, abilityRankMult, DEBUFF_LABEL, type DebuffKind, type SkillNode, type StatModifier } from '@dm/shared';
import type { App } from '../../core/app.js';
import type { Panel, PanelFactory } from '../../ui/domUi.js';
import { activeTreeFor } from '../skills-active/allocate.js';
import { estimateWeaponDamage } from '../combat/playerStats.js';
import { elementColor, elementLabel, elementOf, skillIcon } from './skillIcon.js';
import { dmgAilment } from '../../core/damageTypes.js';
import { STAT_LABEL } from '../inventory/itemView.js';
import { COLORS, mk, tabsBar } from '../../ui/kit.js';
import { buildBindBar } from '../../ui/bindBar.js';

const AOE_RE = /nova|shout|taunt|caltrops|berserk|wolf|horn|rally|blizzard|meteor|trap|rain|skin|wall/;
const PERCENT = new Set(['critChance', 'blockChance', 'resFire', 'resCold', 'resLightning', 'resPoison']);

/** Ярлык формы удара по типу. */
const SHAPE_LABEL: Record<string, string> = {
  strike: 'одиночный удар', cleave: 'дуга по фронту', nova: 'по области (радиус)',
  projectile: 'снаряды (веер)', boomerang: 'бумеранг (туда и обратно)', dash: 'рывок с ударом',
};
/** Подпись стих. статуса по стихии — из конфигов `damage-types` (element→ailment)
 * и общего `DEBUFF_LABEL` (без задвоения). Физический (ailment=null) → «статус». */
function ailmentLabel(elem: string): string {
  const ail = dmgAilment(elem);
  return ail ? DEBUFF_LABEL[ail as DebuffKind].toLowerCase() : 'статус';
}

function fmtMod(m: StatModifier, total?: number): string {
  const label = STAT_LABEL[m.stat] ?? m.stat;
  const pct = m.kind === 'increased' || PERCENT.has(m.stat);
  const v = total ?? m.value;
  const sign = v < 0 ? '' : '+';
  const s = pct ? `${sign}${Math.round(v * 100)}%` : `${sign}${Number.isInteger(v) ? v : v.toFixed(2)}`;
  return `${s} ${label}`;
}

/** Доп. эффекты удара-скилла (замах/стан/отброс/пробитие/стих. статус). */
function skillEffects(active: NonNullable<SkillNode['effect']['active']>, elem: string): string[] {
  const fx: string[] = [];
  if (active.windupSec && active.windupSec > 0) fx.push(`замах ${active.windupSec}с (прерывается станом)`);
  if (active.stunSec && active.stunSec > 0) fx.push(`оглушение ${active.stunSec}с`);
  if (active.knockback && active.knockback > 0) fx.push(`отброс (шанс ${Math.round(active.knockback * 100)}%)`);
  if (active.pierce) fx.push('пробитие целей');
  if (active.ailment) fx.push(`${ailmentLabel(elem)} — шанс ${Math.round(active.ailment.chance * 100)}%`);
  return fx;
}

type Trigger = NonNullable<SkillNode['effect']['triggers']>[number];
function triggerCond(c?: Trigger['condition']): string {
  if (!c) return '';
  if (c.targetBurning) return ' по горящим';
  if (c.targetStunned) return ' по оглушённым';
  if (c.targetFaction) return ` по фракции «${c.targetFaction}»`;
  if (c.selfHpBelowPct != null) return ` при HP < ${Math.round(c.selfHpBelowPct * 100)}%`;
  return '';
}
/** Строка описания реактивного триггера мастерства (за ранг + текущее значение). */
function triggerLine(t: Trigger, rank: number): string {
  const cond = triggerCond(t.condition);
  const e = t.effect;
  const per = (v: number): string => `${Math.round(v * 100)}%`;
  const now = (v: number): string => (rank > 0 ? ` · сейчас ${Math.round(v * 100 * rank)}%` : '');
  if (e.bonusDamagePct != null) return `+${per(e.bonusDamagePct)} урона${cond} за ранг${now(e.bonusDamagePct)}`;
  if (e.reflectPct != null) return `отражает ${per(e.reflectPct)} урона${cond} за ранг${now(e.reflectPct)}`;
  if (e.damageTakenReductionPct != null) return `−${per(e.damageTakenReductionPct)} получаемого урона${cond} за ранг${now(e.damageTakenReductionPct)}`;
  return '';
}

/** Подробное описание узла: тип/урон/скорость/эффекты для активок; моды — для мастерств. */
function describeNode(app: App, node: SkillNode): HTMLElement {
  const state = app.state!;
  const box = mk('div', `font-size:12px;color:#c4bca8;margin:4px 0;line-height:1.5`);
  const active = node.effect.active;

  // ── Мастерство / условный сет-бонус (модификаторы + реактивные триггеры) ──
  if (!active) {
    const rank = state.save.activeSkills[node.id] ?? 0;
    const set = node.effect.setBonus;
    const mods = set ? set.mods : (node.effect.modifiers ?? []);
    const lines = mods.map((m) => {
      const per = fmtMod(m);
      const now = rank > 0 ? ` · сейчас ${fmtMod(m, m.value * rank)}` : '';
      return `${per} за ранг${now}`;
    });
    for (const t of node.effect.triggers ?? []) lines.push(triggerLine(t, rank));
    box.innerHTML = (set ? `<i>Только при полном комплекте брони (${set.minPieces}× ${set.requireArmorClass}):</i><br>` : '')
      + (lines.join('<br>') || node.description);
    return box;
  }

  const rank = Math.max(1, state.save.activeSkills[node.id] ?? 0) || 1;
  const elem = elementOf(node);
  const col = elementColor(elem);

  // ── Тогл (стойка/аура): резерв маны + постоянные моды ──
  if (active.type === 'toggle') {
    const buffs = (active.buffMods ?? []).map((m) => fmtMod(m)).join(', ');
    box.innerHTML =
      `<b>Стойка/аура</b> — вкл/выкл, эксклюзивная группа<br>` +
      (buffs ? `Пока активна: <b>${buffs}</b><br>` : '') +
      `Резерв маны: <b>${Math.round((active.reservePct ?? 0) * 100)}%</b>`;
    return box;
  }

  // ── Временный бафф ──
  if (active.type === 'buff') {
    const buffs = (active.buffMods ?? []).map((m) => fmtMod(m)).join(', ');
    box.innerHTML =
      `<b>Бафф</b> — ${active.durationSec ?? 10} с<br>` +
      (buffs ? `Эффект: <b>${buffs}</b><br>` : '') +
      `Мана: <b>${active.manaCost}</b>`;
    return box;
  }

  // ── Провокация/проклятие ──
  if (active.type === 'curse') {
    box.innerHTML =
      `<b>Провокация</b> — враги в радиусе агрятся на тебя<br>` +
      `Радиус: <b>${active.radius || '≈200'}</b> · Мана: <b>${active.manaCost}</b>`;
    return box;
  }

  // ── Удар/снаряд/рывок: урон от оружия × множитель × ранг ──
  const scaling = app.config.get('balance').weaponAttrScaling;
  const base = estimateWeaponDamage(state, state.save.equipment.weapon, scaling, app.config.get('weapon-weights'));
  const rankMult = abilityRankMult(rank);
  const typed = !!active.type;
  const shape = active.type
    ? SHAPE_LABEL[active.type] ?? 'удар'
    : (AOE_RE.test(active.abilityId) ? 'по области (радиус)' : 'снаряды (веер)');
  const mult = typed ? (active.damageMult ?? 1) : (AOE_RE.test(active.abilityId) ? 1.5 : 1.4);
  const dmg = Math.round(base * mult * rankMult);

  let rateLine: string;
  let dps: number;
  if (typed) {
    // Нет КД: темп удара = скорость атаки × коэффициент скилла.
    const rate = Math.max(0.2, state.derived().attackSpeed * (active.speed ?? 1));
    dps = Math.round(dmg * rate);
    rateLine = `Темп: <b>${(1 / rate).toFixed(2)} с</b>/удар (скор. атаки ×${active.speed ?? 1})`;
  } else {
    const cd = abilityCooldown(active.cooldown, rank);
    dps = cd > 0 ? Math.round(dmg / cd) : dmg;
    rateLine = `Перезарядка: <b>${cd.toFixed(2)} с</b>`;
  }
  const fx = skillEffects(active, elem);
  const count = active.count && active.count > 1 ? ` ×${active.count}` : '';
  box.innerHTML =
    `Стихия: <b style="color:${col}">${elementLabel(elem)}</b> · ${shape}${count}<br>` +
    `Урон ≈ <b style="color:${col}">${dmg}</b> (ДПС ~${dps}, растёт от оружия и ранга)<br>` +
    `${rateLine} · Мана: <b>${active.manaCost}</b>` +
    (fx.length ? `<br>Эффект: <b>${fx.join(', ')}</b>` : '');
  return box;
}

function commit(app: App): void {
  app.bus.emit('state:changed', {}); // онлайн: сейв авторитетен на сервере
}

type Node = SkillNode & { branchId: string };

/** Причина блокировки узла (или null, если доступен). */
function lockReason(app: App, node: Node): string | null {
  const state = app.state!;
  if (state.save.level < node.levelReq) return `требуется уровень ${node.levelReq}`;
  const ok = node.requires.every((r) => (state.save.activeSkills[r] ?? 0) > 0);
  if (!ok) return 'требуется предыдущий узел';
  return null;
}

function nodeRow(app: App, node: Node): HTMLElement {
  const state = app.state!;
  const rank = state.save.activeSkills[node.id] ?? 0;
  const maxed = rank >= node.maxRank;
  const locked = lockReason(app, node);
  const isActive = !!node.effect.active;

  const row = mk('div',
    `border:1px solid ${COLORS.border};border-radius:6px;padding:8px;margin:6px 0;background:${COLORS.bg}`);
  const head = mk('div', 'display:flex;align-items:center;gap:10px');
  head.append(skillIcon(node, 30));
  const titleWrap = mk('div', 'flex:1');
  titleWrap.append(mk('b', `display:block;color:${locked ? '#6a655c' : isActive ? '#e6ddc9' : '#c4bca8'}`, node.name));
  head.append(titleWrap, mk('span', `font-size:12px;color:${COLORS.dim}`, `ранг ${rank}/${node.maxRank}`));
  row.append(head);
  row.append(describeNode(app, node));

  const btn = mk('button', '', maxed ? 'Макс.' : `Прокачать (${node.cost.amount} очк.)`);
  btn.disabled = maxed || !!locked || state.save.unspentSkillPoints < node.cost.amount;
  btn.style.cssText =
    `padding:5px 10px;cursor:pointer;background:${COLORS.border};color:${COLORS.text};border:1px solid ${COLORS.borderHi};border-radius:4px;font-size:12px`;
  if (btn.disabled) btn.style.opacity = '0.5';
  btn.addEventListener('click', () => {
    app.sendCmd({ cmd: 'allocSkill', nodeId: node.id });
  });
  row.append(btn);
  if (locked) row.append(mk('span', 'font-size:11px;color:#666;margin-left:8px', `🔒 ${locked}`));
  return row;
}

/** Панель биндов (D2) внизу окна скиллов — та же, что в HUD. */
function renderBinds(app: App, body: HTMLElement): void {
  body.append(mk('h4', 'margin:12px 0 8px', 'Бинды действий'));
  body.append(buildBindBar(app).el);
  body.append(mk('div', 'font-size:11px;color:#666;margin-top:6px',
    'Клик по слоту → назначить скилл или «Атаку». ЛКМ/ПКМ + доп. слоты Shift/Space/Alt.'));
}

/** Окно активных скиллов (клавиша K): вкладки по веткам, узлы по ярусам (гейт уровня + prereq). */
export const skillsPanel: PanelFactory = (app) => {
  let branch = '';
  const panel: Panel = {
    title: 'Активные скиллы',
    render(body) {
      const state = app.state!;
      const tree = activeTreeFor(app.config, state.save.classId);
      if (!tree) return;
      if (!branch || !tree.branches.some((b) => b.id === branch)) branch = tree.branches[0]!.id;

      // Колонка: фикс-шапка → прокручиваемый список → закреплённый хотбар.
      const wrap = mk('div', 'display:flex;flex-direction:column;max-height:72vh');

      const info = mk('div', `font-size:13px;color:${COLORS.dim};margin-bottom:8px`);
      info.innerHTML = `Очки скиллов: <b style="color:${COLORS.gold}">${state.save.unspentSkillPoints}</b> · пассивы — у Мастера прокачки`;
      wrap.append(info);
      wrap.append(
        tabsBar(
          tree.branches.map((b) => [b.id, b.name] as const),
          branch,
          (key) => { branch = key; app.bus.emit('state:changed', {}); },
        ),
      );

      // Прокручивается только список прокачки.
      const list = mk('div', 'flex:1 1 auto;overflow-y:auto;min-height:0;padding-right:4px');
      const nodes = (tree.nodes as Node[]).filter((n) => n.branchId === branch);
      const tiers = [...new Set(nodes.map((n) => n.levelReq))].sort((a, b) => a - b);
      for (const lvl of tiers) {
        list.append(mk('div', `font-size:12px;color:#8a7acb;margin:12px 0 2px`,
          lvl <= 1 ? 'Ярус 1' : `Открывается с уровня ${lvl}`));
        for (const node of nodes.filter((n) => n.levelReq === lvl)) list.append(nodeRow(app, node));
      }
      wrap.append(list);

      // Бинды закреплены снизу (не прокручиваются).
      const footer = mk('div', `flex:0 0 auto;border-top:1px solid ${COLORS.border};margin-top:8px;padding-top:4px`);
      renderBinds(app, footer);
      wrap.append(footer);

      body.append(wrap);
    },
  };
  return panel;
};
