use std::collections::HashMap;
use std::sync::atomic::Ordering::Relaxed;
use std::sync::Arc;
use std::time::{Duration, Instant};

mod bot;
mod http;
mod report;
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

/// ⭐ R5-24: метрики сервера — или выход с объяснением. Раньше отказ (`/metrics` отвечает 403 стенду не с машины сервера)
/// становился пустой картой: тик 0, CPU 0 %, RSS 0 — и ✓ у перегруженного сервера.
async fn metrics_or_exit(base: &str, key: Option<&str>) -> HashMap<String, f64> {
    match http::metrics(base, key).await {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[dmload] {e}");
            std::process::exit(2);
        }
    }
}

async fn run(a: Args, threads: usize) {
    let base = a.s("base", "http://127.0.0.1:3999");
    let mode = a.s("mode", "ramp");
    // R5-24: ключ чтения метрик сервера (его `DM_METRICS_KEY`) — стенд не с машины сервера без него метрик не получит.
    let metrics_key = a.0.get("metricsKey").cloned()
        .or_else(|| std::env::var("DM_METRICS_KEY").ok())
        .filter(|k| !k.is_empty());

    if mode == "net" {
        net_probe(&base).await;
        return;
    }
    // Сравнение отчётов — работа без сервера: два файла на вход, таблица и оговорки на выход.
    if let Some(pair) = a.0.get("compare") {
        let mut it = pair.split(',');
        match (it.next(), it.next()) {
            (Some(x), Some(y)) => {
                if let Err(e) = report::compare(x, y) {
                    eprintln!("сравнение: {e}");
                    std::process::exit(1);
                }
            }
            _ => eprintln!("--compare=первый.json,второй.json"),
        }
        return;
    }

    let from = a.num("from", a.num("n", 200));
    let step = a.num("step", 0);
    let max = a.num("max", a.num("n", from));
    let mut secs = a.num("secs", 30);
    let warmup = a.num("warmup", 8);
    let hz = a.num("hz", 30);
    let group = a.num("group", 1).max(1) as usize;
    // Зрячие боты: сколько первых разбирают кадры и сверяют сумму. Дороже слепых, поэтому
    // их берут горстью — расхождение протокола видно и на десятке.
    let see = a.num("see", 20);
    // Сценарии С3. Каждый проверяет свой отказ, и все сочетаются друг с другом.
    let churn = a.num("churn", 0);       // сколько ботов рвут связь и возвращаются
    let churn_sec = a.num("churnSec", 30);
    let slow = a.num("slow", 0);         // сколько ботов читают сокет медленно
    let slow_ms = a.num("slowMs", 400);
    let burst = a.0.contains_key("burst"); // подключаться залпом, без разбивки
    let every = a.num("every", 60);      // шаг отчёта в режиме выдержки
    // Выдержка: ступеней нет, есть одна нагрузка и много окон подряд. Ищем не потолок,
    // а ДРЕЙФ — то, что за минуту незаметно, а за час убивает сервер.
    let soak = mode == "soak";
    let total = secs;
    if soak { secs = every; }
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
    if churn > 0 { println!("[dmload] реконнект: {churn} ботов рвут связь каждые ~{churn_sec} с и возвращаются в ту же комнату"); }
    if slow > 0 { println!("[dmload] медленные клиенты: {slow} ботов читают сокет с паузой {slow_ms} мс"); }
    if burst { println!("[dmload] всплеск: подключаемся залпом, без разбивки"); }
    if mode == "soak" { println!("[dmload] выдержка: отчёт каждые {every} с"); }

    // Канал меряем ДО нагрузки: без этой базы непонятно, чья задержка в перцентилях.
    let base_rtt = net_probe(&base).await;

    let st = Arc::new(Stats::new());
    let codes: bot::RoomCodes = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let tag: String = format!("{:x}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() & 0xffffff);

    let mut spawned = 0u64;
    let mut capacity = 0u64;
    let mut target = if soak { a.num("n", from) } else { from };
    /// Окно замера: то, по чему потом видно дрейф.
    struct Window { world: f64, tick: f64, p50: f64, rss: f64, srv_cpu: f64 }
    let mut windows: Vec<Window> = Vec::new();
    let mut rows: Vec<report::Row> = Vec::new();
    // Счётчики обнуляются перед каждым окном, поэтому итог выдержки копим отдельно —
    // иначе в сводке оказались бы числа последней минуты, а не всего прогона.
    let (mut tot_err, mut tot_mis, mut tot_rec, mut tot_chk) = (0u64, 0u64, 0u64, 0u64);
    let started = Instant::now();

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
                churn_sec: if spawned + i < churn { churn_sec } else { 0 },
                slow_ms: if spawned + i < slow { slow_ms } else { 0 },
            };
            let (s, c) = (st.clone(), codes.clone());
            tokio::spawn(bot::run(o, s, c));
            // Вразбивку: залпом мы бы мерили scrypt регистрации, а не игру. `--burst` снимает
            // разбивку намеренно — тогда это и есть сценарий всплеска подключений.
            if !burst {
                tokio::time::sleep(Duration::from_millis(6)).await;
            }
        }
        // Прогрев нужен только после подсадки ботов: в выдержке окна идут встык.
        if need > 0 {
            tokio::time::sleep(Duration::from_secs(warmup)).await;
        }
        spawned = target;

        st.reset();
        let m0 = metrics_or_exit(&base, metrics_key.as_deref()).await;
        let cpu0 = stats::cpu_ms();
        let t0 = Instant::now();
        tokio::time::sleep(Duration::from_secs(secs)).await;
        let dt = t0.elapsed().as_secs_f64();
        let m1 = metrics_or_exit(&base, metrics_key.as_deref()).await;
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
        // Медленные боты по построению читают реже нормы и тянут среднее вниз: гейт на кадры
        // при них меряет НАС, а не сервер. Здоровье сервера в этом сценарии показывают тик,
        // RTT остальных и рост памяти.
        if world < snap_hz * 0.95 && slow == 0 {
            why.push(format!("кадров мира {world:.1} < {:.1}", snap_hz * 0.95));
        }
        if tick > 0.0 && tick < tick_floor {
            why.push(format!("симуляция {tick:.1} Гц — мир в слоу-мо"));
        }
        let p50 = st.rtt_pct(0.5);
        if !(p50 <= rtt_limit) {
            why.push(format!("RTT {p50:.0} мс > {rtt_limit:.0}"));
        }
        // При сценарии реконнекта провал живых до числа перезаходящих — это он и есть,
        // а не отвал. Всё, что глубже, — уже отказ.
        if alive + churn.min(target) < target {
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
        if slow > 0 {
            let dropped = *m1.get("dm_slow_clients_dropped_total").unwrap_or(&0.0)
                - *m0.get("dm_slow_clients_dropped_total").unwrap_or(&0.0);
            println!(
                "        медленных клиентов {slow} (кадры в среднем занижены ими); отключено сервером за окно {dropped:.0}"
            );
        }
        let rec = st.reconnects.load(Relaxed);
        if rec > 0 {
            println!("        возвращений в комнату {rec}");
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
        let us_per_msg = if msgs > 0.0 { self_cpu * dt * 1e6 / msgs } else { f64::NAN };
        rows.push(report::Row {
            bots: target, ok, world, tick, p50, p95: st.rtt_pct(0.95), p99: st.rtt_pct(0.99),
            kb, srv_cpu, self_cpu, rss, us_per_msg,
            checks, mismatches: st.mismatches.load(Relaxed),
        });
        if msgs > 0.0 {
            println!(
                "        стенд: {:.1} мкс на сообщение, {} замеров RTT{}",
                self_cpu * dt * 1e6 / msgs,
                st.rtt_n(),
                if st.rtt_over_scale() > 0 { format!(", {} вне шкалы", st.rtt_over_scale()) } else { String::new() }
            );
        }

        if soak {
            windows.push(Window { world, tick, p50, rss, srv_cpu });
            tot_err += st.errors.load(Relaxed);
            tot_mis += st.mismatches.load(Relaxed);
            tot_rec += st.reconnects.load(Relaxed);
            tot_chk += checks;
            // В выдержке проваленное окно НЕ повод останавливаться: интересно ровно то,
            // как дальше пойдёт деградация, а не факт её начала.
            if started.elapsed().as_secs() >= total {
                break;
            }
            continue;
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

    // Отчёт файлом: сравнивать прогоны должен инструмент, а не глаз (см. report.rs).
    if let Some(out) = a.0.get("out") {
        let params = serde_json::json!({
            "base": base, "mode": mode, "from": from, "step": step, "max": max,
            "secs": secs, "warmup": warmup, "hz": hz, "group": group, "threads": threads,
            "see": see, "churn": churn, "churnSec": churn_sec, "slow": slow, "slowMs": slow_ms,
            "burst": burst, "every": every,
        });
        match report::write(out, params, &rows, capacity, base_rtt) {
            Ok(()) => println!("\nотчёт: {out}"),
            Err(e) => eprintln!("\nотчёт не записан ({out}): {e}"),
        }
    }

    println!("\n════════════════════════════════════════════════════════");
    if soak {
        // Дрейф важнее любого отдельного окна: сервер, который час держит те же числа, и сервер,
        // у которого память растёт по мегабайту в минуту, на коротком замере неразличимы.
        if let (Some(f), Some(l)) = (windows.first(), windows.last()) {
            let mins = (started.elapsed().as_secs_f64() / 60.0).max(1.0);
            println!("ВЫДЕРЖКА {:.0} мин, {} окон, {target} ботов:", mins, windows.len());
            println!("  кадры   {:.1} → {:.1}", f.world, l.world);
            println!("  тик     {:.1} → {:.1} Гц", f.tick, l.tick);
            println!("  RTT p50 {:.1} → {:.1} мс", f.p50, l.p50);
            println!("  RSS     {:.0} → {:.0} МБ ({:+.1} МБ/мин)", f.rss, l.rss, (l.rss - f.rss) / mins);
            println!("  CPU     {:.0} → {:.0} %", f.srv_cpu * 100.0, l.srv_cpu * 100.0);
            println!("  за прогон: сверок дельт {tot_chk}, расхождений {tot_mis} · возвращений в комнату {tot_rec} · ошибок {tot_err}");
        }
        println!("════════════════════════════════════════════════════════");
        std::process::exit(if tot_mis == 0 && tot_err == 0 { 0 } else { 1 });
    }
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
