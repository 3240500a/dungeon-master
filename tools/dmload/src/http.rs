use std::io;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Минимальный HTTP/1.1 клиент.
///
/// ПОЧЕМУ НЕ reqwest. Нам нужны ровно три запроса к своему же серверу в локальной сети:
/// регистрация, создание персонажа и маршрут. Ради них тянуть hyper с rustls — это минуты
/// сборки и десятки зависимостей в инструменте, который должен оставаться понятным целиком.
/// Здесь семьдесят строк: запрос, `Connection: close`, чтение до конца.
///
/// Каждый запрос — своё соединение. На спавне это тысячи коротких соединений, но спавн и так
/// идёт вразбивку (иначе меряется scrypt регистрации, а не игра), а в замере HTTP не участвует.

pub struct Resp {
    pub status: u16,
    pub body: String,
}

fn host_port(base: &str) -> (String, u16, String) {
    // base вида http://192.168.1.146:3001
    let rest = base.strip_prefix("http://").unwrap_or(base);
    let (hostport, _) = rest.split_once('/').unwrap_or((rest, ""));
    let (host, port) = hostport
        .split_once(':')
        .map(|(h, p)| (h.to_string(), p.parse().unwrap_or(80)))
        .unwrap_or((hostport.to_string(), 80));
    (host.clone(), port, format!("{host}:{port}"))
}

async fn request(
    base: &str,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&str>,
) -> io::Result<Resp> {
    let (host, port, hostport) = host_port(base);
    let mut s = TcpStream::connect((host.as_str(), port)).await?;
    s.set_nodelay(true)?;

    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: {hostport}\r\nConnection: close\r\n");
    if let Some(t) = token {
        req.push_str(&format!("Authorization: Bearer {t}\r\n"));
    }
    if let Some(b) = body {
        req.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            b.len()
        ));
    }
    req.push_str("\r\n");
    if let Some(b) = body {
        req.push_str(b);
    }
    s.write_all(req.as_bytes()).await?;

    let mut raw = Vec::with_capacity(4096);
    s.read_to_end(&mut raw).await?;
    let text = String::from_utf8_lossy(&raw).to_string();

    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let body = text
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.to_string())
        .unwrap_or_default();
    Ok(Resp { status, body })
}

pub async fn post(base: &str, path: &str, json: &str, token: Option<&str>) -> io::Result<Resp> {
    request(base, "POST", path, token, Some(json)).await
}

pub async fn get(base: &str, path: &str, token: Option<&str>) -> io::Result<Resp> {
    request(base, "GET", path, token, None).await
}

/// Метрики сервера в формате Prometheus → карта имя→значение.
///
/// Стенд читает их сам и кладёт в свой же отчёт: на сервере не должно оставаться ничего,
/// что нужно смотреть глазами. Работает и с кластером — гейтвей отдаёт сумму по узлам,
/// имена там те же, что у одиночного процесса.
pub async fn metrics(base: &str) -> std::collections::HashMap<String, f64> {
    let mut out = std::collections::HashMap::new();
    let Ok(r) = get(base, "/metrics", None).await else {
        return out;
    };
    for line in r.body.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once(' ') {
            if let Ok(n) = v.trim().parse::<f64>() {
                out.insert(k.to_string(), n);
            }
        }
    }
    out
}

/// Достать строковое поле верхнего уровня из JSON-ответа.
pub fn field(body: &str, key: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    v.get(key)?.as_str().map(|s| s.to_string())
}
