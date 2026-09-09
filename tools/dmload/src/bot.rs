use std::collections::HashMap;
use std::sync::atomic::Ordering::Relaxed;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

use crate::http;
use crate::stats::Stats;
use crate::wire;

/// Один бот: аккаунт, персонаж, маршрут, сокет, ввод и замер задержки.
///
/// ЗРЯЧИЕ И СЛЕПЫЕ. По умолчанию бот не разбирает двоичные кадры мира: серверу безразлично,
/// понимает клиент присланное или выбрасывает — работа сервера та же, а масса ботов выходит
/// заметно дешевле. Но слепая масса не заметит порчу протокола, поэтому `--see=N` делает первые
/// N ботов зрячими: они восстанавливают мир из дельт и сверяют контрольную сумму ТОГО ЖЕ тика.
/// Порт декодера доказан эталоном (`npm run golden:wire` + `cargo test`) — иначе его собственная
/// ошибка выглядела бы как баг сервера.

pub struct BotOpts {
    pub base: String,
    pub tag: String,
    pub index: usize,
    pub input_hz: u64,
    pub group_size: usize,
    pub descend: bool,
    /// Разбирать кадры мира и сверять контрольную сумму.
    pub see: bool,
    /// Через сколько секунд рвать соединение и возвращаться в ту же комнату (0 — не рвать).
    ///
    /// Сценарий реконнекта: комната уходит в грейс, персонаж ждёт возвращения, а не гибнет.
    /// Это единственный путь, который под нагрузкой НЕ проверялся ни разу.
    pub churn_sec: u64,
    /// Читать сокет медленно, мс паузы после каждого кадра (0 — читать сразу).
    ///
    /// Медленный клиент — не выдумка: подвисший главный поток браузера ведёт себя именно так.
    /// Вопрос к серверу один: он копит неотправленное без предела или отключает такого клиента.
    pub slow_ms: u64,
}

/// Коды комнат по группам: хост создаёт комнату, остальные заходят по коду.
/// Код несёт букву узла, поэтому спрашивать маршрут надо УЖЕ С НИМ — иначе гейтвей отправит
/// к другому процессу, где этой комнаты нет.
pub type RoomCodes = Arc<Mutex<HashMap<usize, String>>>;

pub async fn run(o: BotOpts, st: Arc<Stats>, codes: RoomCodes) {
    let who = match enroll(&o).await {
        Ok(v) => v,
        Err(e) => {
            fail(&st, o.index, &e);
            return;
        }
    };
    // Аккаунт заводится ОДИН раз на бота: при churn перезаходит тот же персонаж, иначе мы
    // мерили бы не возвращение в комнату, а регистрацию.
    let mut resume = false;
    loop {
        match session(&o, &st, &codes, &who, resume).await {
            Ok(true) => {
                st.reconnects.fetch_add(1, Relaxed);
                // Дальше заходим ИМЕННО как реконнект, а не «в комнату по коду»: по коду
                // сервер считает незавершённый забег брошенным и выдаёт штраф смерти.
                resume = true;
                continue;
            }
            Ok(false) => break,
            Err(e) => {
                fail(&st, o.index, &e);
                break;
            }
        }
    }
}

fn fail(st: &Arc<Stats>, index: usize, e: &str) {
    st.errors.fetch_add(1, Relaxed);
    // Первые несколько причин полезны, дальше это шум.
    if st.errors.load(Relaxed) <= 5 {
        eprintln!("[бот {index}] {e}");
    }
}

/// Аккаунт и персонаж — один раз за жизнь бота.
struct Who {
    token: String,
    char_id: String,
}

async fn enroll(o: &BotOpts) -> Result<Who, String> {
    let user = format!("rl_{}_{}", o.tag, o.index);
    let r = http::post(
        &o.base,
        "/api/register",
        &format!(r#"{{"username":"{user}","password":"loadtest-password"}}"#),
        None,
    )
    .await
    .map_err(|e| format!("регистрация: {e}"))?;
    if r.status != 200 {
        return Err(format!("регистрация → {} {}", r.status, r.body));
    }
    let token = http::field(&r.body, "token").ok_or("в ответе нет токена")?;

    let r = http::post(
        &o.base,
        "/api/characters",
        &format!(r#"{{"classId":"warrior","name":"R{}"}}"#, o.index),
        Some(&token),
    )
    .await
    .map_err(|e| format!("персонаж: {e}"))?;
    let char_id = serde_json::from_str::<serde_json::Value>(&r.body)
        .ok()
        .and_then(|v| v.get("character")?.get("charId")?.as_str().map(String::from))
        .ok_or_else(|| format!("персонаж → {} {}", r.status, r.body))?;
    Ok(Who { token, char_id })
}

/// Одна сессия: маршрут → сокет → игра. `Ok(true)` — оборвались нарочно, надо перезайти.
async fn session(
    o: &BotOpts, st: &Arc<Stats>, codes: &RoomCodes, who: &Who, resume: bool,
) -> Result<bool, String> {
    let (token, char_id) = (&who.token, &who.char_id);
    let group = o.index / o.group_size;
    let is_host = o.index % o.group_size == 0;

    // Код комнаты нужен всем: не-хост ЖДЁТ его, хост берёт уже известный — при перезаходе
    // это возвращение в ту же комнату, а `fresh` создал бы новую и потерял забег.
    let mut code: Option<String> = codes.lock().await.get(&group).cloned();
    if !is_host && !resume && code.is_none() {
        for _ in 0..200 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if let Some(c) = codes.lock().await.get(&group) {
                code = Some(c.clone());
                break;
            }
        }
    }

    // Маршрут у гейтвея: адрес узла либо место в очереди (очередь — штатный ответ на потолке).
    let mut ticket = String::new();
    let url = loop {
        let mut path = format!("/api/route?charId={char_id}");
        if !ticket.is_empty() {
            path.push_str(&format!("&ticket={ticket}"));
        }
        if let Some(c) = &code {
            path.push_str(&format!("&roomCode={c}"));
        }
        let r = http::get(&o.base, &path, Some(&token))
            .await
            .map_err(|e| format!("маршрут: {e}"))?;
        if r.status == 200 {
            break http::field(&r.body, "url").ok_or("в маршруте нет адреса")?;
        }
        if r.status == 503 {
            if let Some(t) = serde_json::from_str::<serde_json::Value>(&r.body)
                .ok()
                .and_then(|v| v.get("queue")?.get("ticket")?.as_str().map(String::from))
            {
                ticket = t;
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
        }
        return Err(format!("маршрут → {} {}", r.status, r.body));
    };

    let (ws, _) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|e| format!("сокет {url}: {e}"))?;
    let (mut tx, mut rx) = ws.split();
    st.connected.fetch_add(1, Relaxed);
    // Счётчик живых снимается на ЛЮБОМ выходе, включая ошибку из `?`, — иначе оборвавшиеся
    // боты остались бы живыми на бумаге и ворота качества смотрели бы в никуда.
    let _alive = AliveGuard::new(st.clone());

    // ТРИ РАЗНЫХ ВХОДА, и путать их дорого:
    //   resume  — вернуться в свой забег (грейс-комната или пересборка из сейва);
    //   roomCode — осознанный вход в чужую комнату: сервер считает свой незавершённый забег
    //              БРОШЕННЫМ и выдаёт штраф смерти;
    //   fresh   — новая комната с нуля.
    let join = if resume {
        format!(r#"{{"t":"join","token":"{token}","charId":"{char_id}","resume":true}}"#)
    } else {
        match &code {
            Some(c) => format!(r#"{{"t":"join","token":"{token}","charId":"{char_id}","roomCode":"{c}"}}"#),
            None => format!(r#"{{"t":"join","token":"{token}","charId":"{char_id}","fresh":true}}"#),
        }
    };
    send(&mut tx, st, join).await?;

    let mut input = tokio::time::interval(Duration::from_micros(1_000_000 / o.input_hz.max(1)));
    let mut ping = tokio::time::interval(Duration::from_secs(1));
    let mut ping_id: u64 = 0;
    let mut ping_at: HashMap<u64, Instant> = HashMap::new();
    let mut angle = (o.index as f64) * 0.37;
    let mut seq: u64 = 0;
    let mut world = wire::Snapshot::default();
    // Разброс в разрыве обязателен: одновременный уход всех — это уже сценарий всплеска,
    // а не реконнекта, и он проверяется отдельно.
    let churn_at = (o.churn_sec > 0).then(|| {
        Instant::now() + Duration::from_millis(o.churn_sec * 1000 + (o.index as u64 % 17) * 250)
    });

    loop {
        if let Some(at) = churn_at {
            if Instant::now() >= at {
                return Ok(true);
            }
        }
        tokio::select! {
            _ = input.tick() => {
                // Направление плавно вращается: постоянный вектор дал бы монстрам скучный
                // сценарий, а случайный каждый кадр — нереалистичную дёрганность.
                angle += 0.11;
                let (sx, cx) = angle.sin_cos();
                seq += 1;
                let frame = format!(
                    r#"{{"t":"input","seq":{seq},"input":{{"move":{{"x":{cx:.4},"y":{sx:.4}}},"facing":{angle:.4},"attack":true,"cast":null,"interact":false}}}}"#
                );
                st.input_sent.fetch_add(1, Relaxed);
                send(&mut tx, st, frame).await?;
            }
            _ = ping.tick() => {
                ping_id += 1;
                ping_at.insert(ping_id, Instant::now());
                if ping_at.len() > 32 { let old = ping_id.saturating_sub(32); ping_at.remove(&old); }
                send(&mut tx, st, format!(r#"{{"t":"ping","id":{ping_id}}}"#)).await?;
            }
            msg = rx.next() => {
                let Some(msg) = msg else { return Ok(false) };
                let msg = msg.map_err(|e| format!("приём: {e}"))?;
                match msg {
                    Message::Binary(b) => {
                        st.bytes_in.fetch_add(b.len() as u64, Relaxed);
                        st.world_frames.fetch_add(1, Relaxed);
                        if o.see {
                            match wire::decode(&b) {
                                Ok(f) => {
                                    world = f.apply(&world);
                                    st.checks.fetch_add(1, Relaxed);
                                    if world.checksum() != f.sum {
                                        st.mismatches.fetch_add(1, Relaxed);
                                    }
                                }
                                // Нечитаемый кадр — это отказ протокола, а не «пропустим один».
                                Err(e) => return Err(format!("кадр мира: {e}")),
                            }
                        }
                    }
                    Message::Text(t) => {
                        st.bytes_in.fetch_add(t.len() as u64, Relaxed);
                        st.text_frames.fetch_add(1, Relaxed);
                        handle_text(&t, o, st, codes, group, is_host, &mut tx, &mut ping_at).await?;
                    }
                    Message::Close(_) => return Ok(false),
                    _ => {}
                }
                // Медленный клиент: не читаем, пока сервер копит. Пауза здесь — это давление
                // на его исходящую очередь, ровно как подвисший главный поток браузера.
                if o.slow_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(o.slow_ms)).await;
                }
            }
        }
    }
}

/// Снимает бота с учёта живых, чем бы сессия ни кончилась.
struct AliveGuard(Arc<Stats>);
impl AliveGuard {
    fn new(st: Arc<Stats>) -> Self {
        st.alive.fetch_add(1, Relaxed);
        Self(st)
    }
}
impl Drop for AliveGuard {
    fn drop(&mut self) {
        self.0.alive.fetch_sub(1, Relaxed);
    }
}

type Tx = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Message,
>;

async fn send(tx: &mut Tx, st: &Arc<Stats>, s: String) -> Result<(), String> {
    st.bytes_out.fetch_add(s.len() as u64, Relaxed);
    tx.send(Message::Text(s.into()))
        .await
        .map_err(|e| format!("отправка: {e}"))
}

#[allow(clippy::too_many_arguments)]
async fn handle_text(
    t: &str,
    o: &BotOpts,
    st: &Arc<Stats>,
    codes: &RoomCodes,
    group: usize,
    is_host: bool,
    tx: &mut Tx,
    ping_at: &mut HashMap<u64, Instant>,
) -> Result<(), String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(t) else { return Ok(()) };
    match v.get("t").and_then(|x| x.as_str()).unwrap_or("") {
        "pong" => {
            if let Some(id) = v.get("id").and_then(|x| x.as_u64()) {
                if let Some(at) = ping_at.remove(&id) {
                    st.add_rtt(at.elapsed().as_micros() as u64);
                }
            }
        }
        "joined" => {
            if let Some(c) = v.get("roomCode").and_then(|x| x.as_str()) {
                codes.lock().await.entry(group).or_insert_with(|| c.to_string());
            }
            let in_town = v.get("floor").and_then(|f| f.get("depth")).and_then(|d| d.as_i64()) == Some(0);
            // Спускаемся ТОЛЬКО из города: при перезаходе комната уже на этаже, и повторный
            // спуск увёл бы пати глубже вместо возвращения в забег.
            if o.descend && is_host && in_town {
                // Небольшой разброс, чтобы группы не спускались одним залпом.
                let d = 1500 + (o.index as u64 % 7) * 200;
                tokio::time::sleep(Duration::from_millis(d)).await;
                send(tx, st, r#"{"t":"descend","difficultyId":"normal"}"#.to_string()).await?;
            }
        }
        "voteStart" => {
            send(tx, st, r#"{"t":"vote","accept":true}"#.to_string()).await?;
        }
        "error" => {
            st.errors.fetch_add(1, Relaxed);
            if st.errors.load(Relaxed) <= 5 {
                eprintln!("[бот {}] сервер: {}", o.index, v.get("msg").and_then(|x| x.as_str()).unwrap_or(""));
            }
        }
        _ => {}
    }
    Ok(())
}
