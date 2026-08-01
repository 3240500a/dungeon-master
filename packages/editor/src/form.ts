import { z } from 'zod';

/**
 * Генератор форм из zod-схем. Рекурсивно строит DOM-контролы под тип поля
 * (object/array/tuple/record/enum/number/string/boolean/literal), разворачивая
 * optional/default/nullable. Изменения пишутся обратно в переданное значение через
 * onChange корня. Один код обслуживает все конфиги — новое поле схемы появляется
 * в редакторе автоматически.
 */

type AnySchema = z.ZodTypeAny;

/**
 * Спец-источники значений для полей по ИМЕНИ (напр. minTier/maxTier → список тиров).
 * Заполняется снаружи (main.ts). Если поле есть здесь — рисуем выпадашку из этих
 * значений вместо контрола по схеме. Так нельзя вписать несуществующий id.
 */
export const fieldEnumSources: Record<string, () => string[]> = {};

/** Контрол поля: спец-источник по имени (тиры и т.п.), иначе — по схеме. */
function fieldControl(key: string, sub: AnySchema, value: unknown, onChange: (v: unknown) => void): HTMLElement {
  const src = fieldEnumSources[key];
  // Enum-выпадашка по имени поля — ТОЛЬКО для строковых полей. Иначе одноимённые числовые
  // поля (напр. `weight` брони = числовая масса vs `weight` оружия = id-класс веса) рендерились
  // бы списком и записывали строку в число → ошибка валидации.
  const tn = unwrap(sub).schema._def.typeName;
  // Спец-источник — ТОЛЬКО для строковых полей (id-ссылки). Enum-поля (напр. floors.role) рендерят
  // СВОИ значения, чтобы одноимённое строковое поле-ссылка (monsters.role) не перехватывало их.
  if (src && tn === 'ZodString') {
    return renderEnum(src(), value == null ? '' : String(value), onChange);
  }
  return renderField(sub, value, onChange);
}

interface Unwrapped {
  schema: AnySchema;
  optional: boolean;
  /** Задан ли `.default(...)` где-то в обёртке (для скаляров используем его значение). */
  hasDefault: boolean;
  defaultVal: unknown;
}

function unwrap(schema: AnySchema): Unwrapped {
  let s = schema;
  let optional = false;
  let hasDefault = false;
  let defaultVal: unknown;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const tn = s._def.typeName;
    if (tn === 'ZodOptional' || tn === 'ZodNullable') {
      optional = true;
      s = s._def.innerType;
    } else if (tn === 'ZodDefault') {
      if (!hasDefault) { defaultVal = s._def.defaultValue(); hasDefault = true; }
      s = s._def.innerType;
    } else if (tn === 'ZodEffects') {
      s = s._def.schema;
    } else break;
  }
  return { schema: s, optional, hasDefault, defaultVal };
}

/** Значение по умолчанию для схемы (для «Добавить», новых элементов массива, смены варианта union). */
export function defaultValue(schema: AnySchema): unknown {
  const u = unwrap(schema);
  const s = u.schema;
  const tn = s._def.typeName;
  // Скаляры с .default(...) — берём заданное значение (иначе number.default(4) даёт 0 и падает min(1)).
  if (u.hasDefault && (tn === 'ZodNumber' || tn === 'ZodString' || tn === 'ZodBoolean' || tn === 'ZodEnum' || tn === 'ZodLiteral')) {
    return u.defaultVal;
  }
  switch (tn) {
    case 'ZodObject': {
      const shape = (s as z.ZodObject<z.ZodRawShape>).shape;
      const out: Record<string, unknown> = {};
      for (const [k, sub] of Object.entries(shape)) out[k] = defaultValue(sub);
      return out;
    }
    case 'ZodDiscriminatedUnion': {
      const raw = s._def.options;
      const opts = (Array.isArray(raw) ? raw : [...raw.values()]) as AnySchema[];
      return opts.length ? defaultValue(opts[0]!) : {};
    }
    case 'ZodArray':
      return [];
    case 'ZodTuple':
      return (s._def.items as AnySchema[]).map(defaultValue);
    case 'ZodRecord':
      return {};
    case 'ZodEnum':
      return s._def.values[0];
    case 'ZodLiteral':
      return s._def.value;
    case 'ZodNumber':
      return 0;
    case 'ZodBoolean':
      return false;
    case 'ZodString':
      return '';
    default:
      return null;
  }
}

function label(text: string): HTMLElement {
  const el = document.createElement('label');
  el.textContent = text;
  el.style.cssText = 'display:block;font-size:11px;color:#9aa;margin:1px 0 1px';
  return el;
}

/** «Блочные» типы (объект/массив/union/запись) занимают всю ширину строки грида; скаляры — в колонку. */
function isBlockSchema(schema: AnySchema): boolean {
  const tn = unwrap(schema).schema._def.typeName;
  return tn === 'ZodObject' || tn === 'ZodArray' || tn === 'ZodDiscriminatedUnion' || tn === 'ZodRecord';
}

/** Сетка полей: скаляры пакуются в колонки (авто-заполнение), блочные — на всю ширину. */
const FIELD_GRID = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:4px 12px;align-items:end';

/** Кладёт поле в ячейку грида (блочное — на всю строку). */
function gridCell(grid: HTMLElement, key: string, sub: AnySchema, value: unknown, onChange: (v: unknown) => void): void {
  const cell = document.createElement('div');
  if (isBlockSchema(sub)) cell.style.gridColumn = '1 / -1';
  cell.appendChild(label(key));
  cell.appendChild(fieldControl(key, sub, value, onChange));
  grid.appendChild(cell);
}

const inputStyle =
  'width:100%;box-sizing:border-box;padding:5px 8px;background:#0f0f16;color:#e8e8f0;border:1px solid #2c2c3a;border-radius:4px;font-size:13px';

/** Рисует контрол для значения по схеме. onChange получает новое значение поля. */
export function renderField(
  schema: AnySchema,
  value: unknown,
  onChange: (v: unknown) => void,
): HTMLElement {
  const { schema: s } = unwrap(schema);
  const tn = s._def.typeName;

  switch (tn) {
    case 'ZodObject':
      return renderObject(s as z.ZodObject<z.ZodRawShape>, (value as Record<string, unknown>) ?? {}, onChange);
    case 'ZodDiscriminatedUnion':
      return renderDiscriminatedUnion(s, (value as Record<string, unknown>) ?? {}, onChange);
    case 'ZodArray':
      return renderArray(s._def.type, Array.isArray(value) ? value : [], onChange);
    case 'ZodTuple':
      return renderTuple(s._def.items as AnySchema[], Array.isArray(value) ? value : [], onChange);
    case 'ZodRecord':
      return renderRecord(s._def.valueType, (value as Record<string, unknown>) ?? {}, onChange);
    case 'ZodEnum':
      return renderEnum(s._def.values as string[], value as string, onChange);
    case 'ZodBoolean':
      return renderBoolean(Boolean(value), onChange);
    case 'ZodNumber':
      return renderNumber(typeof value === 'number' ? value : 0, onChange);
    case 'ZodLiteral':
      return renderLiteral(s._def.value);
    case 'ZodString':
    default:
      return renderString(value == null ? '' : String(value), onChange);
  }
}

function renderString(value: string, onChange: (v: unknown) => void): HTMLElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.style.cssText = inputStyle;
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

function renderNumber(value: number, onChange: (v: unknown) => void): HTMLElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = 'any';
  input.value = String(value);
  input.style.cssText = inputStyle;
  input.addEventListener('input', () => onChange(input.value === '' ? 0 : Number(input.value)));
  return input;
}

function renderBoolean(value: boolean, onChange: (v: unknown) => void): HTMLElement {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = value;
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

function renderEnum(values: string[], value: string, onChange: (v: unknown) => void): HTMLElement {
  const sel = document.createElement('select');
  sel.style.cssText = inputStyle;
  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    if (v === value) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function renderLiteral(value: unknown): HTMLElement {
  const el = document.createElement('div');
  el.textContent = String(value);
  el.style.cssText = 'font-size:12px;color:#888;padding:4px 0';
  return el;
}

/**
 * Дискриминированный union (напр. items.base по `kind`): селектор вида + поля только
 * выбранного варианта. Переключение вида переносит совпадающие поля, остальное — дефолты.
 */
function renderDiscriminatedUnion(
  schema: AnySchema,
  value: Record<string, unknown>,
  onChange: (v: unknown) => void,
): HTMLElement {
  const disc: string = schema._def.discriminator;
  const raw = schema._def.options;
  const options = (Array.isArray(raw) ? raw : [...raw.values()]) as z.ZodObject<z.ZodRawShape>[];
  const byKind = new Map<string, z.ZodObject<z.ZodRawShape>>();
  for (const opt of options) {
    byKind.set(String((opt.shape[disc] as AnySchema)._def.value), opt);
  }
  const kinds = [...byKind.keys()];

  const box = document.createElement('div');
  box.style.cssText = 'border-left:2px solid #2c2c3a;padding:2px 0 2px 10px;margin:4px 0';

  // Смена вида: переносим совпадающие поля, остальные — дефолты варианта; мутируем value
  // НА МЕСТЕ (сохраняя ссылку у родителя) и ПЕРЕРИСОВЫВАЕМ поля под новый вид.
  const applyKind = (nv: string): void => {
    const variant = byKind.get(nv)!;
    const merged = defaultValue(variant) as Record<string, unknown>;
    for (const k of Object.keys(variant.shape)) {
      if (k !== disc && value[k] !== undefined) merged[k] = value[k];
    }
    merged[disc] = nv;
    for (const k of Object.keys(value)) delete value[k];
    Object.assign(value, merged);
    onChange(value);
    rebuild();
  };

  const rebuild = (): void => {
    box.innerHTML = '';
    let activeKind = String(value[disc] ?? '');
    if (!byKind.has(activeKind)) activeKind = kinds[0]!;

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px';
    head.appendChild(label(disc));
    head.appendChild(renderEnum(kinds, activeKind, (nv) => applyKind(String(nv))));
    box.appendChild(head);

    const grid = document.createElement('div');
    grid.style.cssText = FIELD_GRID;
    const variant = byKind.get(activeKind)!;
    for (const [key, sub] of Object.entries(variant.shape)) {
      if (key === disc) continue;
      gridCell(grid, key, sub, value[key], (v) => {
        value[key] = v;
        value[disc] = activeKind;
        onChange(value);
      });
    }
    box.appendChild(grid);
  };

  rebuild();
  return box;
}

function renderObject(
  schema: z.ZodObject<z.ZodRawShape>,
  value: Record<string, unknown>,
  onChange: (v: unknown) => void,
): HTMLElement {
  const box = document.createElement('div');
  box.style.cssText = FIELD_GRID + ';border-left:2px solid #2c2c3a;padding:2px 0 2px 10px;margin:4px 0';
  const shape = schema.shape;
  for (const [key, sub] of Object.entries(shape)) {
    gridCell(box, key, sub, value[key], (v) => {
      value[key] = v;
      onChange(value);
    });
  }
  return box;
}

function smallBtn(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.type = 'button';
  b.style.cssText = 'margin:4px 4px 4px 0;padding:3px 8px;cursor:pointer;background:#2c2c3a;color:#e8e8f0;border:1px solid #3c3c4a;border-radius:4px;font-size:12px';
  b.addEventListener('click', onClick);
  return b;
}

function renderArray(
  elemSchema: AnySchema,
  value: unknown[],
  onChange: (v: unknown) => void,
): HTMLElement {
  const box = document.createElement('div');
  box.style.cssText = 'border:1px solid #2c2c3a;border-radius:6px;padding:6px 8px;margin:4px 0';

  const rebuild = () => {
    box.innerHTML = '';
    value.forEach((item, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'border-bottom:1px dashed #2c2c3a;padding:3px 0';
      const head = document.createElement('div');
      head.style.cssText = 'display:flex;justify-content:space-between;align-items:center';
      const title = document.createElement('b');
      title.textContent = `#${i}`;
      title.style.cssText = 'font-size:11px;color:#889';
      head.appendChild(title);
      head.appendChild(
        smallBtn('Удалить', () => {
          value.splice(i, 1);
          onChange(value);
          rebuild();
        }),
      );
      row.appendChild(head);
      row.appendChild(
        renderField(elemSchema, item, (v) => {
          value[i] = v;
          onChange(value);
        }),
      );
      box.appendChild(row);
    });
    box.appendChild(
      smallBtn('+ Добавить', () => {
        value.push(defaultValue(elemSchema));
        onChange(value);
        rebuild();
      }),
    );
  };
  rebuild();
  return box;
}

function renderTuple(
  items: AnySchema[],
  value: unknown[],
  onChange: (v: unknown) => void,
): HTMLElement {
  const box = document.createElement('div');
  box.style.cssText = 'display:flex;gap:8px';
  items.forEach((sub, i) => {
    const cell = renderField(sub, value[i], (v) => {
      value[i] = v;
      onChange(value);
    });
    cell.style.flex = '1';
    box.appendChild(cell);
  });
  return box;
}

function renderRecord(
  valueSchema: AnySchema,
  value: Record<string, unknown>,
  onChange: (v: unknown) => void,
): HTMLElement {
  const box = document.createElement('div');
  box.style.cssText = 'border:1px solid #2c2c3a;border-radius:6px;padding:8px;margin:4px 0';
  const rebuild = () => {
    box.innerHTML = '';
    for (const key of Object.keys(value)) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;margin:4px 0';
      const keySpan = document.createElement('span');
      keySpan.textContent = key;
      keySpan.style.cssText = 'min-width:110px;font-size:12px;color:#cbd';
      const val = renderField(valueSchema, value[key], (v) => {
        value[key] = v;
        onChange(value);
      });
      val.style.flex = '1';
      row.append(keySpan, val, smallBtn('✕', () => {
        delete value[key];
        onChange(value);
        rebuild();
      }));
      box.appendChild(row);
    }
    const addRow = document.createElement('div');
    const keyInput = document.createElement('input');
    keyInput.placeholder = 'новый ключ';
    keyInput.style.cssText = inputStyle + ';width:auto;display:inline-block';
    addRow.append(keyInput, smallBtn('+ ключ', () => {
      const k = keyInput.value.trim();
      if (k && !(k in value)) {
        value[k] = defaultValue(valueSchema);
        onChange(value);
        rebuild();
      }
    }));
    box.appendChild(addRow);
  };
  rebuild();
  return box;
}
