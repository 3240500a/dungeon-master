use std::collections::HashMap;
use std::sync::atomic::Ordering::Relaxed;
use std::sync::Arc;
use std::time::{Duration, Instant};

mod bot;
mod http;
mod stats;
mod wire;

use stats::Stats;

/// dmload — нагрузочный стенд игры.
///
/// ЗАЧЕМ ОН, ЕСЛИ СТЕНД УЖЕ ЕСТЬ. Прежний, на Node, тратит 31 мкс процессора на сообщение
/// против 13 мкс у самого сервера: прибор дороже измеряемого в 2,4 раза. Хуже того, его паузы
/// сборки мусора попадают в наши перцентили и выглядят как задержка сервера. Здесь ни того,
/// ни другого нет: задача tokio — это килобайты, пауз нет вовсе, а перцентили считаются
/// по КАЖДОМУ замеру, а не по средним ботов.
///
///   dmload --base=http://127.0.0.1:3999 --n=400 --secs=30
///   dmload --base=http://192.168.1.146:3001 --from=200 --step=200 --max=2000   (поиск потолка)
///   dmload --base=... --mode=net                                              (замер канала)

struct Args(HashMap<String, String>);

impl Args {
    fn parse() -> Self {
        let mut m = HashMap::new();
        for a in std::env::args().skip(1) {
            let a = a.trim_start_matches("--").to_string();
            match a.split_once('=') {
                Some((k, v)) => m.insert(k.to_string(), v.to_string()),
                None => m.insert(a, "true".into()),
            };
        }
        Self(m)
    }
    fn num(&self, k: &str, d: u64) -> u64 {
        self.0.get(k).and_then(|v| v.parse().ok()).unwrap_or(d)
    }
    fn s(&self, k: &str, d: &str) -> String {
        self.0.get(k).cloned().unwrap_or_else(|| d.to_string())
    }
}

fn main() {
    let a = Args::parse();
    // Число рабочих потоков — ручка, а не умолчание.
    //
    // Умолчание tokio — поток на ядро. Для нас это худший вариант: работы на сообщение
    // микроскопически мало, зато каждый таймер бота будит поток и тянет задачу через
    // work-stealing между ядрами. Пробуждение потока на Windows стоит дороже самой работы,
    // и стенд начинает мерить собственную диспетчеризацию. Несколько потоков с плотной
    // загрузкой дешевле, чем шестнадцать почти пустых.
    let threads = a.num("threads", 4).max(1) as usize;
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(threads)
        .enable_all()
        .build()
        .expect("рантайм");
    rt.block_on(run(a, threads));
}

async fn run(a: Args, threads: usize) {
    let base = a.s("base", "http://127.0.0.1:3999");
    let mode = a.s("mode", "ramp");

    if mode == "net" {
        net_probe(&base).await;
        return;
    }

    let from = a.num("from", a.num("n", 200));
    let step = a.num("step", 0);
    let max = a.num("max", a.num("n", from));
    let secs = a.num("secs", 30);
    let warmup = a.num("warmup", 8);
    let hz = a.num("hz", 30);
    let group = a.num("group", 1).max(1) as usize;
    // Зрячие боты: сколько первых разбирают кадры и сверяют сумму. Дороже слепых, поэтому
    // их берут горстью — расхождение протокола видно и на десятке.
    let see = a.num("see", 20);
    let snap_hz = a.num("snapHz", 20) as f64;
    let rtt_limit = a.num("rttLimit", 120) as f64;
    let tick_floor = a.num("tickFloor", 28) as f64;

    println!("[dmload] сервер {base} · потоков стенда {threads}");
    println!(
        "[dmload] {} ботов{}, пати по {group}, ввод {hz} Гц, ступень {secs} с",
        from,
        if step > 0 { format!("…{max} шагом {step}") } else { String::new() }
    );
    println!("[dmload] зрячих ботов {see} (разбирают кадры и сверяют сумму)");

    // Канал меряем ДО нагрузки: без этой базы непонятно, чья задержка в перцентилях.
    let base_rtt = net_probe(&base).await;

    let st = Arc::new(Stats::new());
    let codes: bot::RoomCodes = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let tag: String = format!("{:x}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() & 0xffffff);

    let mut spawned = 0u64;
    let mut capacity = 0u64;
    let mut target = from;

    loop {
        // Доводим число ботов до ступени.
        let need = target.saturating_sub(spawned);
        for i in 0..need {
            let o = bot::BotOpts {
                base: base.clone(),
                tag: tag.clone(),
                index: (spawned + i) as usize,
                input_hz: hz,
                group_size: group,
                descend: true,
                see: spawned + i < see,
            };
            let (s, c) = (st.clone(), codes.clone());
            tokio::spawn(bot::run(o, s, c));
            // Вразбивку: залпом мы бы мерили scrypt регистрации, а не игру.
            tokio::time::sleep(Duration::from_millis(6)).await;
        }
        spawned = target;

        tokio::time::sleep(Duration::from_secs(warmup)).await;
        st.reset();
        let m0 = http::metrics(&base).await;
        let cpu0 = stats::cpu_ms();
        let t0 = Instant::now();
        tokio::time::sleep(Duration::from_secs(secs)).await;
        let dt = t0.elapsed().as_secs_f64();
        let m1 = http::metrics(&base).await;
        let self_cpu = (stats::cpu_ms() - cpu0) / 1000.0 / dt;

        let alive = st.alive.load(Relaxed);
        let world = st.world_frames.load(Relaxed) as f64 / dt / alive.max(1) as f64;
        let kb = st.bytes_in.load(Relaxed) as f64 / dt / 1024.0 / alive.max(1) as f64;
        let srv_cpu = ((m1.get("dm_cpu_user_seconds_total").unwrap_or(&0.0)
            - m0.get("dm_cpu_user_seconds_total").unwrap_or(&0.0))
            + (m1.get("dm_cpu_system_seconds_total").unwrap_or(&0.0)
                - m0.get("dm_cpu_system_seconds_total").unwrap_or(&0.0)))
            / dt;
        let tick = *m1.get("dm_tick_hz").unwrap_or(&0.0);
        let nodes = *m1.get("dm_nodes").unwrap_or(&0.0);
        let rss = m1.get("dm_rss_bytes").unwrap_or(&0.0) / 1048576.0;

        let mut why: Vec<String> = Vec::new();
        if world < snap_hz * 0.95 {
            why.push(format!("кадров мира {world:.1} < {:.1}", snap_hz * 0.95));
        }
        if tick > 0.0 && tick < tick_floor {
            why.push(format!("симуляция {tick:.1} Гц — мир в слоу-мо"));
        }
        let p50 = st.rtt_pct(0.5);
        if !(p50 <= rtt_limit) {
            why.push(format!("RTT {p50:.0} мс > {rtt_limit:.0}"));
        }
        if alive != target {
            why.push(format!("живых {alive}/{target}"));
        }
        if st.errors.load(Relaxed) > 0 {
            why.push(format!("ошибок {}", st.errors.load(Relaxed)));
        }
        // Расхождение реконструкции — отказ протокола: смысла мерить дальше нет.
        if st.mismatches.load(Relaxed) > 0 {
            why.push(format!("расхождений дельт {}", st.mismatches.load(Relaxed)));
        }

        let ok = why.is_empty();
        println!(
            "{:>5} ботов  {}  кадры {:.1}/с · тик {:.1} Гц · RTT {:.1}/{:.1}/{:.1} мс (p50/p95/p99) · {:.1} КБ/с · CPU сервер {:.0}% стенд {:.0}% · RSS {:.0} МБ{}",
            target,
            if ok { "✓" } else { "✗" },
            world, tick,
            p50, st.rtt_pct(0.95), st.rtt_pct(0.99),
            kb, srv_cpu * 100.0, self_cpu * 100.0, rss,
            if nodes > 1.0 { format!(" · узлов {nodes:.0}") } else { String::new() }
        );
        if !ok {
            println!("        {}", why.join(" · "));
        }
        let checks = st.checks.load(Relaxed);
        if checks > 0 {
            println!(
                "        сверок дельт {checks}, расхождений {} (зрячих ботов {})",
                st.mismatches.load(Relaxed),
                see.min(target)
            );
        }
        // Стенд обязан знать свою цену: 50 сообщений в секунду на бота — это его работа.
        let msgs = (st.input_sent.load(Relaxed) + st.world_frames.load(Relaxed) + st.text_frames.load(Relaxed)) as f64;
        if msgs > 0.0 {
            println!(
                "        стенд: {:.1} мкс на сообщение, {} замеров RTT{}",
                self_cpu * dt * 1e6 / msgs,
                st.rtt_n(),
                if st.rtt_over_scale() > 0 { format!(", {} вне шкалы", st.rtt_over_scale()) } else { String::new() }
            );
        }

        if !ok {
            break;
        }
        capacity = target;
        if step == 0 || target >= max {
            break;
        }
        target = (target + step).min(max);
    }

    println!("\n════════════════════════════════════════════════════════");
    println!(
        "ЁМКОСТЬ: {capacity} игроков{}",
        if base_rtt.is_finite() { format!(" · задержка канала вхолостую {base_rtt:.2} мс") } else { String::new() }
    );
    println!("════════════════════════════════════════════════════════");
    std::process::exit(if capacity > 0 { 0 } else { 1 });
}

/// Замер канала до нагрузки: задержка вхолостую по HTTP.
///
/// Нужна как база: без неё нельзя отличить задержку сервера от задержки сети — а на Wi-Fi
/// вторая легко превышает первую.
async fn net_probe(base: &str) -> f64 {
    let mut best = f64::INFINITY;
    let mut sum = 0.0;
    let mut n = 0;
    for _ in 0..10 {
        let t = Instant::now();
        if http::get(base, "/api/health", None).await.is_ok() {
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            best = best.min(ms);
            sum += ms;
            n += 1;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    if n == 0 {
        println!("[канал] сервер не отвечает на {base}/api/health");
        return f64::NAN;
    }
    println!("[канал] задержка вхолостую: лучшая {best:.2} мс, средняя {:.2} мс ({n} проб)", sum / n as f64);
    best
}
