use std::collections::HashMap;
use std::sync::atomic::Ordering::Relaxed;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

use crate::http;
use crate::stats::Stats;

/// Один бот: аккаунт, персонаж, маршрут, сокет, ввод и замер задержки.
///
/// ЧТО БОТ НЕ ДЕЛАЕТ (пока): не разбирает двоичные кадры мира. Серверу безразлично, понимает
/// клиент присланное или выбрасывает — работа сервера та же, а масса ботов получается вдесятеро
/// дешевле. Корректность протокола проверяют «зрячие» боты: сейчас это десяток ботов прежнего
/// стенда на TypeScript, дальше — доля ботов здесь же (фаза С2).

pub struct BotOpts {
    pub base: String,
    pub tag: String,
    pub index: usize,
    pub input_hz: u64,
    pub group_size: usize,
    pub descend: bool,
}

/// Коды комнат по группам: хост создаёт комнату, остальные заходят по коду.
/// Код несёт букву узла, поэтому спрашивать маршрут надо УЖЕ С НИМ — иначе гейтвей отправит
/// к другому процессу, где этой комнаты нет.
pub type RoomCodes = Arc<Mutex<HashMap<usize, String>>>;

pub async fn run(o: BotOpts, st: Arc<Stats>, codes: RoomCodes) {
    if let Err(e) = play(&o, &st, &codes).await {
        st.errors.fetch_add(1, Relaxed);
        // Первые несколько причин полезны, дальше это шум.
        if st.errors.load(Relaxed) <= 5 {
            eprintln!("[бот {}] {e}", o.index);
        }
    }
    st.alive.fetch_sub(1, Relaxed);
}

async fn play(o: &BotOpts, st: &Arc<Stats>, codes: &RoomCodes) -> Result<(), String> {
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

    let group = o.index / o.group_size;
    let is_host = o.index % o.group_size == 0;

    // Не-хост ждёт код комнаты ДО маршрутизации.
    let mut code: Option<String> = None;
    if !is_host {
        for _ in 0..200 {
            if let Some(c) = codes.lock().await.get(&group) {
                code = Some(c.clone());
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
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
    st.alive.fetch_add(1, Relaxed);

    let join = match &code {
        Some(c) => format!(r#"{{"t":"join","token":"{token}","charId":"{char_id}","roomCode":"{c}"}}"#),
        None => format!(r#"{{"t":"join","token":"{token}","charId":"{char_id}","fresh":true}}"#),
    };
    send(&mut tx, st, join).await?;

    let mut input = tokio::time::interval(Duration::from_micros(1_000_000 / o.input_hz.max(1)));
    let mut ping = tokio::time::interval(Duration::from_secs(1));
    let mut ping_id: u64 = 0;
    let mut ping_at: HashMap<u64, Instant> = HashMap::new();
    let mut angle = (o.index as f64) * 0.37;
    let mut seq: u64 = 0;

    loop {
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
                let Some(msg) = msg else { return Ok(()) };
                let msg = msg.map_err(|e| format!("приём: {e}"))?;
                match msg {
                    Message::Binary(b) => {
                        st.bytes_in.fetch_add(b.len() as u64, Relaxed);
                        st.world_frames.fetch_add(1, Relaxed);
                    }
                    Message::Text(t) => {
                        st.bytes_in.fetch_add(t.len() as u64, Relaxed);
                        st.text_frames.fetch_add(1, Relaxed);
                        handle_text(&t, o, st, codes, group, is_host, &mut tx, &mut ping_at).await?;
                    }
                    Message::Close(_) => return Ok(()),
                    _ => {}
                }
            }
        }
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
            if o.descend && is_host {
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
