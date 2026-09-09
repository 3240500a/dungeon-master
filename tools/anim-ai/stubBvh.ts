/**
 * ЗАГЛУШЕЧНЫЙ BVH — фикстура, на которой проверяется ВЕСЬ канал генерации без единого гигабайта весов.
 *
 * ЗАЧЕМ. Модель живёт на другой машине, а канал «промпт → сеть → шим → запекатель → клип в библиотеке»
 * надо проверить здесь и сейчас. Заглушка отдаёт настоящий, разбираемый BVH с НАШИМИ каноническими
 * именами костей, поэтому проходит ровно тот же путь, что пойдёт настоящий ответ движка:
 * `BVHLoader` → `autoBoneMap` → `makeBakeRig` → `clipBaker` → `Clip`.
 *
 * ДВИЖЕНИЕ НАМЕРЕННО НЕЛЕПОЕ (обе руки машут, корпус качается). Заглушку не должно быть возможно
 * перепутать с настоящей генерацией: клип, случайно оставшийся в библиотеке, обязан кричать о себе.
 *
 * Чистая функция без сети и файлов — поэтому проверяется node-тестом рядом.
 */

/** Узел скелета: имя (наше каноническое), смещение от родителя, дети. */
interface Joint { name: string; off: [number, number, number]; kids?: Joint[]; end?: [number, number, number] }

/** Порядок каналов поворота у BVH — ZXY, как принято в формате (и как ждёт `BVHLoader`). */
const ROT = 'Zrotation Xrotation Yrotation';

/**
 * Скелет в Т-позе. Пропорции взяты близкими к нашему ригу (рост ~61 юнит), но точность здесь не важна:
 * запекатель снимает ПОВОРОТЫ относительно рест-позы источника, а не длины — длины берутся с модели.
 */
function skeleton(): Joint {
  const arm = (s: 1 | -1): Joint => ({
    name: s > 0 ? 'LeftShoulder' : 'RightShoulder', off: [3 * s, 4, 0],
    kids: [{
      name: s > 0 ? 'LeftUpperArm' : 'RightUpperArm', off: [4 * s, 0, 0],
      kids: [{
        name: s > 0 ? 'LeftLowerArm' : 'RightLowerArm', off: [13 * s, 0, 0],
        kids: [{ name: s > 0 ? 'LeftHand' : 'RightHand', off: [12 * s, 0, 0], end: [4 * s, 0, 0] }],
      }],
    }],
  });
  const leg = (s: 1 | -1): Joint => ({
    name: s > 0 ? 'LeftUpperLeg' : 'RightUpperLeg', off: [4 * s, -2, 0],
    kids: [{
      name: s > 0 ? 'LeftLowerLeg' : 'RightLowerLeg', off: [0, -16, 0],
      kids: [{
        name: s > 0 ? 'LeftFoot' : 'RightFoot', off: [0, -15, 0],
        kids: [{ name: s > 0 ? 'LeftToes' : 'RightToes', off: [0, -3, 6], end: [0, 0, 4] }],
      }],
    }],
  });
  return {
    name: 'Hips', off: [0, 0, 0],
    kids: [
      {
        name: 'Spine', off: [0, 7, 0],
        kids: [{
          name: 'Chest', off: [0, 6, 0],
          kids: [{
            name: 'UpperChest', off: [0, 5, 0],
            kids: [
              { name: 'Neck', off: [0, 5, 0], kids: [{ name: 'Head', off: [0, 4, 0], end: [0, 5, 0] }] },
              arm(1), arm(-1),
            ],
          }],
        }],
      },
      leg(1), leg(-1),
    ],
  };
}

/** Обход в том же порядке, в каком идут каналы в кадре, — иерархия и данные обязаны совпасть. */
function flatten(j: Joint, out: Joint[] = []): Joint[] {
  out.push(j);
  for (const k of j.kids ?? []) flatten(k, out);
  return out;
}

function hierarchy(j: Joint, depth: number, root: boolean): string {
  const pad = '  '.repeat(depth);
  const head = root ? `ROOT ${j.name}` : `JOINT ${j.name}`;
  const ch = root ? `CHANNELS 6 Xposition Yposition Zposition ${ROT}` : `CHANNELS 3 ${ROT}`;
  let s = `${pad}${head}\n${pad}{\n${pad}  OFFSET ${j.off.join(' ')}\n${pad}  ${ch}\n`;
  for (const k of j.kids ?? []) s += hierarchy(k, depth + 1, false);
  if (j.end) s += `${pad}  End Site\n${pad}  {\n${pad}    OFFSET ${j.end.join(' ')}\n${pad}  }\n`;
  return s + `${pad}}\n`;
}

export interface StubOpts { seconds?: number; fps?: number }

/**
 * Собрать BVH заданной длительности. `seconds` приходит прямо из вкладки AI редактора,
 * поэтому длина ответа обязана от него зависеть — иначе заглушка не проверяет передачу параметров.
 */
export function makeStubBvh(opts: StubOpts = {}): string {
  const fps = Math.max(1, Math.round(opts.fps ?? 30));
  const seconds = Math.min(Math.max(opts.seconds ?? 2, 0.1), 30);
  const frames = Math.max(2, Math.round(seconds * fps));
  const root = skeleton();
  const joints = flatten(root);

  const lines: string[] = [];
  for (let f = 0; f < frames; f++) {
    const t = f / fps;
    const wave = Math.sin(t * Math.PI * 2) * 45;        // мах руками ±45°
    const sway = Math.sin(t * Math.PI) * 8;             // качание корпуса ±8°
    const vals: number[] = [];
    for (const j of joints) {
      if (j.name === 'Hips') vals.push(0, 0, 0);        // корневая позиция: травел запекатель всё равно отбрасывает
      // Каналы идут Z, X, Y — держим этот порядок и в данных.
      if (j.name === 'Spine') vals.push(sway, 0, 0);
      else if (j.name === 'LeftUpperArm') vals.push(0, 0, wave);
      else if (j.name === 'RightUpperArm') vals.push(0, 0, -wave);
      else if (j.name === 'LeftLowerArm' || j.name === 'RightLowerArm') vals.push(0, Math.abs(wave) * 0.4, 0);
      else if (j.name === 'Head') vals.push(-sway, 0, 0);
      else vals.push(0, 0, 0);
    }
    lines.push(vals.map((v) => v.toFixed(4)).join(' '));
  }

  return 'HIERARCHY\n' + hierarchy(root, 0, true)
    + `MOTION\nFrames: ${frames}\nFrame Time: ${(1 / fps).toFixed(6)}\n`
    + lines.join('\n') + '\n';
}
