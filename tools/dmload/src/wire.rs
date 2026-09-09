use std::f64::consts::TAU;

/// Порт клиентской половины протокола: разбор двоичного кадра, наложение дельты,
/// контрольная сумма мира.
///
/// ЗАЧЕМ ПОРТ, А НЕ СЛЕПЫЕ БОТЫ. Слепой бот считает байты и кадры, но не заметит, что кадры
/// испорчены: сервер может слать мусор, а стенд покажет зелёные цифры. Зрячий бот
/// восстанавливает мир и сверяет контрольную сумму того же тика — это ловит порчу протокола
/// сразу и без отладчика.
///
/// ГЛАВНАЯ ОПАСНОСТЬ ПОРТА в том, что его собственная ошибка выглядит как баг сервера.
/// Поэтому он не имеет права работать «на вид»: `npm run golden:wire` записывает точную
/// последовательность настоящих кадров вместе с ожидаемыми суммами, а `tests/golden.rs`
/// прогоняет её здесь. Пока эталон не сойдётся, зрячим ботам верить нельзя.
///
/// ЧТО ТУТ НЕ ХРАНИТСЯ. В сумму входят не все поля: маны, выносливости, радиуса, состояния ИИ,
/// дебаффов и содержимого дропа здесь нет — они не нужны ни для сверки, ни для нагрузки.
/// Но РАЗОБРАТЬ их обязательно: они лежат в потоке между нужными, и ошибка в их длине сдвинет
/// чтение — остаток кадра рассыплется. Именно поэтому сверка суммы проверяет разбор целиком.

pub const WIRE_FULL: u8 = 1;
pub const WIRE_DELTA: u8 = 2;

// Биты маски полей игрока (значения — из shared/session/wire.ts, менять только вместе).
const P_X: u16 = 1;
const P_Y: u16 = 2;
const P_FACING: u16 = 4;
const P_HP: u16 = 8;
const P_MANA: u16 = 16;
const P_STAMINA: u16 = 32;
const P_ALIVE: u16 = 64;
const P_DEBUFFS: u16 = 128;
const P_TOGGLES: u16 = 256;
const P_INCOMBAT: u16 = 512;
// Биты маски полей монстра.
const M_X: u16 = 1;
const M_Y: u16 = 2;
const M_FACING: u16 = 4;
const M_HP: u16 = 8;
const M_MAXHP: u16 = 16;
const M_ALIVE: u16 = 32;
const M_R: u16 = 64;
const M_AI: u16 = 128;
const M_DEBUFFS: u16 = 256;
const M_STUN: u16 = 512;
const M_DOWNED: u16 = 1024;

#[derive(Debug)]
pub enum WireError {
    Short,
    Utf8,
    Json,
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            WireError::Short => "кадр оборвался",
            WireError::Utf8 => "строка не в UTF-8",
            WireError::Json => "не разобрался JSON в кадре",
        })
    }
}

struct Reader<'a> {
    b: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], WireError> {
        let end = self.pos.checked_add(n).ok_or(WireError::Short)?;
        if end > self.b.len() {
            return Err(WireError::Short);
        }
        let s = &self.b[self.pos..end];
        self.pos = end;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, WireError> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, WireError> {
        let s = self.take(2)?;
        Ok(u16::from_le_bytes([s[0], s[1]]))
    }
    fn i16(&mut self) -> Result<i16, WireError> {
        Ok(self.u16()? as i16)
    }
    fn u32(&mut self) -> Result<u32, WireError> {
        let s = self.take(4)?;
        Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn i32(&mut self) -> Result<i32, WireError> {
        Ok(self.u32()? as i32)
    }
    fn str(&mut self) -> Result<&'a str, WireError> {
        let n = self.u16()? as usize;
        std::str::from_utf8(self.take(n)?).map_err(|_| WireError::Utf8)
    }
    /// Пропустить строку, не разбирая: дебаффы и предметы дропа в сумму не входят.
    fn skip_str(&mut self) -> Result<(), WireError> {
        let n = self.u16()? as usize;
        self.take(n)?;
        Ok(())
    }
}

/// Квантование координаты обратно в мир: четверть игрового пикселя.
fn pos_u(q: i16) -> f64 {
    q as f64 / 4.0
}
/// Квантование угла обратно: полный оборот на 65536 шагов.
fn ang_u(q: u16) -> f64 {
    q as f64 / 65536.0 * TAU
}

/// `ToInt32` из ECMAScript: усечение к нулю и обрезка до 32 бит — то, что делает `| 0`.
fn to_i32(v: f64) -> i32 {
    if !v.is_finite() {
        return 0;
    }
    (v.trunc() as i64 as u64 as u32) as i32
}

/// `Math.round`: половина ВВЕРХ (к +∞), а не «от нуля», как у `f64::round`.
/// Различие видно только на ровной половине, но воспроизводить надо ровно то поведение.
fn js_round(v: f64) -> f64 {
    (v + 0.5).floor()
}

/// Квантование величины для контрольной суммы: 1/16 игрового пикселя.
fn q(v: f64) -> i32 {
    to_i32(js_round(v * 16.0))
}

/// Хеш строки как на сервере: по кодовым единицам UTF-16, не по байтам.
fn str_hash(s: &str) -> i32 {
    let mut h: i32 = 0;
    for u in s.encode_utf16() {
        h = h.wrapping_mul(31).wrapping_add(u as i32);
    }
    h
}

#[derive(Clone, Debug, Default)]
pub struct Player {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub facing: f64,
    pub hp: u32,
    pub alive: bool,
    pub in_combat: bool,
    /// Только длина: в сумму входит `toggles.length`, сами строки не нужны.
    pub toggles: usize,
}

#[derive(Clone, Debug, Default)]
pub struct Monster {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub facing: f64,
    pub hp: u32,
    pub alive: bool,
    pub stun: bool,
    pub downed: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub tick: u32,
    pub players: Vec<Player>,
    pub monsters: Vec<Monster>,
    /// Снаряды и дропы участвуют в сумме только числом и идентификаторами.
    pub projectiles: Vec<u32>,
    pub drops: Vec<u32>,
}

impl Snapshot {
    /// Контрольная сумма мира — та же арифметика, что в `shared/session/delta.ts`.
    ///
    /// Сумма коммутативна (складываем вклады сущностей), поэтому порядок в списках не важен —
    /// а он у реконструкции свой.
    pub fn checksum(&self) -> i32 {
        let mut h = (self.players.len() as i32)
            .wrapping_mul(7919)
            .wrapping_add((self.monsters.len() as i32).wrapping_mul(104729))
            .wrapping_add((self.drops.len() as i32).wrapping_mul(31))
            .wrapping_add((self.projectiles.len() as i32).wrapping_mul(17));
        for p in &self.players {
            h = h
                .wrapping_add(str_hash(&p.id))
                .wrapping_add(q(p.x).wrapping_mul(3))
                .wrapping_add(q(p.y).wrapping_mul(5))
                .wrapping_add(q(p.facing).wrapping_mul(9))
                .wrapping_add(q(p.hp as f64).wrapping_mul(7))
                .wrapping_add(if p.alive { 11 } else { 0 })
                .wrapping_add(if p.in_combat { 13 } else { 0 })
                .wrapping_add((p.toggles as i32).wrapping_mul(19));
        }
        for m in &self.monsters {
            h = h
                // Math.imul(id, 2654435761): множитель больше 2^31, ToInt32 делает его отрицательным.
                .wrapping_add((m.id as i32).wrapping_mul(-1640531535))
                .wrapping_add(q(m.x).wrapping_mul(3))
                .wrapping_add(q(m.y).wrapping_mul(5))
                .wrapping_add(q(m.facing).wrapping_mul(9))
                .wrapping_add(q(m.hp as f64).wrapping_mul(7))
                .wrapping_add(if m.alive { 11 } else { 0 })
                .wrapping_add(if m.stun { 13 } else { 0 })
                .wrapping_add(if m.downed { 17 } else { 0 });
        }
        for d in &self.drops {
            h = h.wrapping_add((*d as i32).wrapping_mul(40503));
        }
        h
    }
}

/// Патч игрока: заданы только изменившиеся поля.
struct PlayerPatch {
    id: String,
    x: Option<f64>,
    y: Option<f64>,
    facing: Option<f64>,
    hp: Option<u32>,
    alive: Option<bool>,
    in_combat: Option<bool>,
    toggles: Option<usize>,
}

struct MonsterPatch {
    id: u32,
    x: Option<f64>,
    y: Option<f64>,
    facing: Option<f64>,
    hp: Option<u32>,
    alive: Option<bool>,
    stun: Option<bool>,
    downed: Option<bool>,
}

/// Разобранный кадр: вид, номер тика, изменения и сумма для сверки.
pub struct Frame {
    pub kind: u8,
    pub tick: u32,
    pub sum: i32,
    pu: Vec<PlayerPatch>,
    pd: Vec<String>,
    mu: Vec<MonsterPatch>,
    md: Vec<u32>,
    /// `None` — списка не было; для снарядов это ЗНАЧИМО (см. `apply`).
    ru: Option<Vec<u32>>,
    rd: Vec<u32>,
    du: Vec<u32>,
    dd: Vec<u32>,
}

pub fn decode(buf: &[u8]) -> Result<Frame, WireError> {
    let mut r = Reader { b: buf, pos: 0 };
    let kind = r.u8()?;
    let tick = r.u32()?;
    let sum = r.i32()?;

    // ── игроки ──
    let n = r.u8()? as usize;
    let mut pu = Vec::with_capacity(n);
    for _ in 0..n {
        let id = r.str()?.to_string();
        let mask = r.u16()?;
        let mut p = PlayerPatch {
            id, x: None, y: None, facing: None, hp: None,
            alive: None, in_combat: None, toggles: None,
        };
        if mask & P_X != 0 { p.x = Some(pos_u(r.i16()?)); }
        if mask & P_Y != 0 { p.y = Some(pos_u(r.i16()?)); }
        if mask & P_FACING != 0 { p.facing = Some(ang_u(r.u16()?)); }
        if mask & P_HP != 0 { p.hp = Some(r.u32()?); }
        if mask & P_MANA != 0 { r.u32()?; }
        if mask & P_STAMINA != 0 { r.u32()?; }
        // Один байт на оба флага, но каждый берётся ТОЛЬКО если его бит стоит в маске:
        // иначе отсутствующий в патче флаг погасил бы живое значение на клиенте.
        if mask & (P_ALIVE | P_INCOMBAT) != 0 {
            let f = r.u8()?;
            if mask & P_ALIVE != 0 { p.alive = Some(f & 1 != 0); }
            if mask & P_INCOMBAT != 0 { p.in_combat = Some(f & 2 != 0); }
        }
        if mask & P_DEBUFFS != 0 { r.skip_str()?; }
        if mask & P_TOGGLES != 0 {
            // Единственный JSON, который приходится разбирать: в сумму входит длина списка.
            let s = r.str()?;
            let v: serde_json::Value = serde_json::from_str(s).map_err(|_| WireError::Json)?;
            p.toggles = Some(v.as_array().map(|a| a.len()).unwrap_or(0));
        }
        pu.push(p);
    }
    let n = r.u8()? as usize;
    let mut pd = Vec::with_capacity(n);
    for _ in 0..n {
        pd.push(r.str()?.to_string());
    }

    // ── монстры ──
    let n = r.u16()? as usize;
    let mut mu = Vec::with_capacity(n);
    for _ in 0..n {
        let id = r.u32()?;
        let mask = r.u16()?;
        let mut m = MonsterPatch {
            id, x: None, y: None, facing: None, hp: None,
            alive: None, stun: None, downed: None,
        };
        if mask & M_X != 0 { m.x = Some(pos_u(r.i16()?)); }
        if mask & M_Y != 0 { m.y = Some(pos_u(r.i16()?)); }
        if mask & M_FACING != 0 { m.facing = Some(ang_u(r.u16()?)); }
        if mask & M_HP != 0 { m.hp = Some(r.u32()?); }
        if mask & M_MAXHP != 0 { r.u32()?; }
        if mask & (M_ALIVE | M_STUN | M_DOWNED) != 0 {
            let f = r.u8()?;
            if mask & M_ALIVE != 0 { m.alive = Some(f & 1 != 0); }
            if mask & M_STUN != 0 { m.stun = Some(f & 2 != 0); }
            if mask & M_DOWNED != 0 { m.downed = Some(f & 4 != 0); }
        }
        if mask & M_R != 0 { r.u8()?; }
        if mask & M_AI != 0 { r.u8()?; }
        if mask & M_DEBUFFS != 0 { r.skip_str()?; }
        mu.push(m);
    }
    let n = r.u16()? as usize;
    let mut md = Vec::with_capacity(n);
    for _ in 0..n {
        md.push(r.u32()?);
    }

    // ── снаряды: всегда целиком ──
    let n = r.u16()? as usize;
    let ru = if n > 0 {
        let mut v = Vec::with_capacity(n);
        for _ in 0..n {
            let id = r.u32()?;
            r.i16()?; // x
            r.i16()?; // y
            r.u8()?; // владелец
            r.skip_str()?; // доминирующая стихия
            r.u8()?; // радиус
            v.push(id);
        }
        Some(v)
    } else {
        None
    };
    let n = r.u16()? as usize;
    let mut rd = Vec::with_capacity(n);
    for _ in 0..n {
        rd.push(r.u32()?);
    }

    // ── дропы: только приход и уход ──
    let n = r.u16()? as usize;
    let mut du = Vec::with_capacity(n);
    for _ in 0..n {
        let id = r.u32()?;
        r.i16()?; // x
        r.i16()?; // y
        r.skip_str()?; // предмет целиком — в сумму не входит
        du.push(id);
    }
    let n = r.u16()? as usize;
    let mut dd = Vec::with_capacity(n);
    for _ in 0..n {
        dd.push(r.u32()?);
    }

    Ok(Frame { kind, tick, sum, pu, pd, mu, md, ru, rd, du, dd })
}

impl Frame {
    /// Наложить кадр на состояние клиента. Полный кадр применяется к ПУСТОМУ миру —
    /// так обе стороны используют один путь применения.
    pub fn apply(&self, prev: &Snapshot) -> Snapshot {
        let base = Snapshot::default();
        let prev = if self.kind == WIRE_FULL { &base } else { prev };

        let mut players = prev.players.clone();
        if !self.pd.is_empty() {
            players.retain(|p| !self.pd.iter().any(|id| id == &p.id));
        }
        for patch in &self.pu {
            match players.iter_mut().find(|p| p.id == patch.id) {
                Some(p) => {
                    if let Some(v) = patch.x { p.x = v; }
                    if let Some(v) = patch.y { p.y = v; }
                    if let Some(v) = patch.facing { p.facing = v; }
                    if let Some(v) = patch.hp { p.hp = v; }
                    if let Some(v) = patch.alive { p.alive = v; }
                    if let Some(v) = patch.in_combat { p.in_combat = v; }
                    if let Some(v) = patch.toggles { p.toggles = v; }
                }
                None => players.push(Player {
                    id: patch.id.clone(),
                    x: patch.x.unwrap_or(0.0),
                    y: patch.y.unwrap_or(0.0),
                    facing: patch.facing.unwrap_or(0.0),
                    hp: patch.hp.unwrap_or(0),
                    alive: patch.alive.unwrap_or(false),
                    in_combat: patch.in_combat.unwrap_or(false),
                    toggles: patch.toggles.unwrap_or(0),
                }),
            }
        }

        let mut monsters = prev.monsters.clone();
        if !self.md.is_empty() {
            monsters.retain(|m| !self.md.contains(&m.id));
        }
        for patch in &self.mu {
            match monsters.iter_mut().find(|m| m.id == patch.id) {
                Some(m) => {
                    if let Some(v) = patch.x { m.x = v; }
                    if let Some(v) = patch.y { m.y = v; }
                    if let Some(v) = patch.facing { m.facing = v; }
                    if let Some(v) = patch.hp { m.hp = v; }
                    if let Some(v) = patch.alive { m.alive = v; }
                    if let Some(v) = patch.stun { m.stun = v; }
                    if let Some(v) = patch.downed { m.downed = v; }
                }
                None => monsters.push(Monster {
                    id: patch.id,
                    x: patch.x.unwrap_or(0.0),
                    y: patch.y.unwrap_or(0.0),
                    facing: patch.facing.unwrap_or(0.0),
                    hp: patch.hp.unwrap_or(0),
                    alive: patch.alive.unwrap_or(false),
                    stun: patch.stun.unwrap_or(false),
                    downed: patch.downed.unwrap_or(false),
                }),
            }
        }

        // Снаряды: список приходит ЦЕЛИКОМ, поэтому его отсутствие означает «снарядов нет»,
        // а не «оставить прежние». Ровно так же считает и клиент игры.
        let projectiles = match &self.ru {
            Some(v) => v.clone(),
            None if !self.rd.is_empty() => {
                prev.projectiles.iter().copied().filter(|id| !self.rd.contains(id)).collect()
            }
            None => Vec::new(),
        };

        let drops = if self.du.is_empty() && self.dd.is_empty() {
            prev.drops.clone()
        } else {
            let mut v: Vec<u32> = prev.drops.iter().copied().filter(|id| !self.dd.contains(id)).collect();
            v.extend(self.du.iter().copied());
            v
        };

        Snapshot { tick: self.tick, players, monsters, projectiles, drops }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Прогон эталона: настоящая последовательность кадров с сервера должна дать те же суммы.
    ///
    /// Эталон пишется `npm run golden:wire`. Если тест упал после правки протокола — сперва
    /// перегенерировать эталон и посмотреть на разницу, а не «подправить» порт под новые числа.
    #[test]
    fn golden() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden.json");
        let text = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("нет эталона {path}: {e} — сгенерируйте npm run golden:wire"));
        let doc: serde_json::Value = serde_json::from_str(&text).expect("эталон не разобрался");
        let frames = doc["frames"].as_array().expect("в эталоне нет frames");
        assert!(frames.len() > 100, "эталон подозрительно короткий: {}", frames.len());

        let mut world = Snapshot::default();
        let mut checked = 0;
        for (i, f) in frames.iter().enumerate() {
            let hex = f["hex"].as_str().unwrap();
            let bytes: Vec<u8> = (0..hex.len() / 2)
                .map(|k| u8::from_str_radix(&hex[k * 2..k * 2 + 2], 16).unwrap())
                .collect();
            let frame = decode(&bytes).unwrap_or_else(|e| panic!("кадр {i}: {e}"));

            assert_eq!(frame.kind as u64, f["kind"].as_u64().unwrap(), "кадр {i}: вид");
            assert_eq!(frame.tick as u64, f["tick"].as_u64().unwrap(), "кадр {i}: тик");
            assert_eq!(frame.sum as i64, f["sum"].as_i64().unwrap(), "кадр {i}: сумма в кадре");

            world = frame.apply(&world);

            // Состав — чтобы расхождение можно было локализовать, а не только увидеть.
            assert_eq!(world.players.len() as u64, f["players"].as_u64().unwrap(), "кадр {i}: игроков");
            assert_eq!(world.monsters.len() as u64, f["monsters"].as_u64().unwrap(), "кадр {i}: монстров");
            assert_eq!(world.projectiles.len() as u64, f["projectiles"].as_u64().unwrap(), "кадр {i}: снарядов");
            assert_eq!(world.drops.len() as u64, f["drops"].as_u64().unwrap(), "кадр {i}: дропов");

            assert_eq!(world.checksum(), frame.sum, "кадр {i} (тик {}): реконструкция разошлась", frame.tick);
            checked += 1;
        }
        assert_eq!(checked, frames.len());
    }

    #[test]
    fn js_arithmetic() {
        // Math.round — половина ВВЕРХ, а не «от нуля»: Math.round(-2.5) === -2.
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(2.5), 3.0);
        // ToInt32 сворачивает по модулю 2^32 со знаком.
        assert_eq!(to_i32(4294967295.0), -1);
        assert_eq!(to_i32(2147483648.0), i32::MIN);
        // Хеш строки — по кодовым единицам UTF-16 (проверено против JS).
        assert_eq!(str_hash(""), 0);
        assert_eq!(str_hash("abc"), 96354);
    }
}
