/**
 * Кастом-виджеты полей 3D-ассетов для конфиг-редактора (вкладки Меши/Текстуры/Материалы):
 *  - ЦВЕТ (baseColor/emissive): tuple [r,g,b] 0..1 ↔ <input type=color> + хекс-поле;
 *  - URL (текстура/меш): текст-поле + кнопка загрузки файла на сервер (`POST /api/dev/assets/<id>`
 *    → `{ url }`; расширение из типа файла) — сразу пишет полученный url в поле.
 * Регистрируются в `main.ts` через `fieldCustomRenderers` по имени поля. Аплоад — DEV-only (в проде 403).
 */

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const to255 = (n: number): number => Math.round(clamp01(n) * 255);
const hex2 = (n: number): string => n.toString(16).padStart(2, '0');
function rgbToHex(rgb: unknown): string {
  const a = Array.isArray(rgb) ? (rgb as number[]) : [0, 0, 0];
  return '#' + hex2(to255(a[0] ?? 0)) + hex2(to255(a[1] ?? 0)) + hex2(to255(a[2] ?? 0));
}
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const inputCss = 'box-sizing:border-box;padding:5px 8px;background:#0f0f16;color:#e8e8f0;border:1px solid #2c2c3a;border-radius:4px;font-size:13px';

/** Пикер цвета для tuple [r,g,b] 0..1 (baseColor/emissive материала). Палитра + хекс синхронны. */
export function renderColorField(value: unknown, onChange: (v: unknown) => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:8px;align-items:center';
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.value = rgbToHex(value);
  picker.style.cssText = 'width:44px;height:28px;padding:0;border:1px solid #2c2c3a;border-radius:4px;background:#0f0f16;cursor:pointer';
  const txt = document.createElement('input');
  txt.type = 'text';
  txt.value = rgbToHex(value);
  txt.style.cssText = inputCss + ';flex:1';
  const sync = (hex: string): void => {
    const rgb = hexToRgb(hex);
    picker.value = rgbToHex(rgb); txt.value = rgbToHex(rgb);
    onChange(rgb);
  };
  picker.addEventListener('input', () => sync(picker.value));
  txt.addEventListener('change', () => sync(txt.value));
  wrap.append(picker, txt);
  return wrap;
}

const CONTENT_TYPE: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  glb: 'model/gltf-binary', gltf: 'model/gltf-binary',
};

/** Залить бинарь на сервер под `id` → `{ url }`. contentType задаёт расширение файла на диске. */
async function uploadAsset(id: string, data: ArrayBuffer, contentType: string): Promise<{ url: string }> {
  const r = await fetch('/api/dev/assets/' + encodeURIComponent(id), {
    method: 'POST', headers: { 'content-type': contentType }, body: data,
  });
  if (!r.ok) throw new Error('upload ' + r.status);
  return r.json() as Promise<{ url: string }>;
}

/** Текст-поле url + кнопка загрузки файла (PNG/JPG/WEBP/GLB) на сервер → url ассета. `parent.id` → имя файла. */
export function renderUploadField(value: unknown, onChange: (v: unknown) => void, parent: Record<string, unknown> | undefined): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap';
  const txt = document.createElement('input');
  txt.type = 'text';
  txt.value = value == null ? '' : String(value);
  txt.placeholder = '/assets/<id>.<ext>';
  txt.style.cssText = inputCss + ';flex:1;min-width:160px';
  txt.addEventListener('input', () => onChange(txt.value));
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = '.png,.jpg,.jpeg,.webp,.glb,.gltf';
  file.style.display = 'none';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '⬆ Загрузить';
  btn.style.cssText = 'padding:5px 8px;cursor:pointer;background:#2c2c3a;color:#e8e8f0;border:1px solid #3c3c4a;border-radius:4px;font-size:12px;white-space:nowrap';
  const status = document.createElement('span');
  status.style.cssText = 'font-size:11px;color:#9aa';
  btn.addEventListener('click', () => file.click());
  file.addEventListener('change', () => {
    const f = file.files?.[0];
    if (!f) return;
    const ext = f.name.toLowerCase().split('.').pop() ?? 'bin';
    const id = String((parent?.id as string) || f.name.replace(/\.[^.]+$/, '')).replace(/[^a-zA-Z0-9_-]/g, '') || 'asset';
    status.textContent = 'загрузка…'; status.style.color = '#ffb020';
    f.arrayBuffer()
      .then((buf) => uploadAsset(id, buf, CONTENT_TYPE[ext] ?? 'application/octet-stream'))
      .then((res) => { txt.value = res.url; onChange(res.url); status.textContent = 'ок · ' + id + '.' + ext; status.style.color = '#7fd67f'; })
      .catch((e: Error) => { status.textContent = 'ошибка: ' + e.message; status.style.color = '#ff6b6b'; });
  });
  wrap.append(txt, btn, file, status);
  return wrap;
}
