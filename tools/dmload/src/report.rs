use serde_json::{json, Value};

/// Отчёт прогона и сравнение двух отчётов (фаза С4).
///
/// ЗАЧЕМ. Правило замера в этом проекте одно и выстрадано: **сравнивать только прогоны подряд**.
/// Но глазами сравнивают плохо — прошлый разбор уже один раз поехал ровно на этом: числа дня
/// сопоставили с числами ночи, и вышел вывод об оптимизации, которой не было (машина в тот день
/// была на 11 % медленнее). Поэтому сравнение делает не человек, а инструмент, и он же ГРОМКО
/// говорит, когда сравнивать нельзя: разные параметры, разные машины, разрыв во времени.

/// Строка отчёта: одна ступень поиска потолка или одно окно выдержки.
#[derive(Clone)]
pub struct Row {
    pub bots: u64,
    pub ok: bool,
    pub world: f64,
    pub tick: f64,
    pub p50: f64,
    pub p95: f64,
    pub p99: f64,
    pub kb: f64,
    pub srv_cpu: f64,
    pub self_cpu: f64,
    pub rss: f64,
    pub us_per_msg: f64,
    pub checks: u64,
    pub mismatches: u64,
}

impl Row {
    fn to_json(&self) -> Value {
        json!({
            "bots": self.bots, "ok": self.ok,
            "world": self.world, "tick": self.tick,
            "p50": self.p50, "p95": self.p95, "p99": self.p99,
            "kb": self.kb, "srvCpu": self.srv_cpu, "selfCpu": self.self_cpu,
            "rss": self.rss, "usPerMsg": self.us_per_msg,
            "checks": self.checks, "mismatches": self.mismatches,
        })
    }
}

/// Записать отчёт. `params` — всё, что делает прогоны сравнимыми или несравнимыми.
pub fn write(path: &str, params: Value, rows: &[Row], capacity: u64, base_rtt: f64) -> std::io::Result<()> {
    let doc = json!({
        "at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
        "host": std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default(),
        "params": params,
        "capacity": capacity,
        "baseRttMs": if base_rtt.is_finite() { json!(base_rtt) } else { Value::Null },
        "rows": rows.iter().map(Row::to_json).collect::<Vec<_>>(),
    });
    std::fs::write(path, serde_json::to_string_pretty(&doc)?)
}

fn load(path: &str) -> Result<Value, String> {
    let t = std::fs::read_to_string(path).map_err(|e| format!("{path}: {e}"))?;
    serde_json::from_str(&t).map_err(|e| format!("{path}: {e}"))
}

fn f(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(|x| x.as_f64()).unwrap_or(f64::NAN)
}

/// Сравнить два отчёта. Печатает таблицу и, главное, оговорки — если сравнивать нельзя.
pub fn compare(a_path: &str, b_path: &str) -> Result<(), String> {
    let (a, b) = (load(a_path)?, load(b_path)?);

    println!("A: {a_path}");
    println!("B: {b_path}\n");

    // Сначала — можно ли вообще сравнивать. Это важнее самих чисел.
    let mut warn: Vec<String> = Vec::new();
    let (pa, pb) = (&a["params"], &b["params"]);
    for k in ["base", "group", "hz", "secs", "warmup", "threads", "see", "churn", "slow", "burst", "mode"] {
        if pa.get(k) != pb.get(k) {
            warn.push(format!("{k}: {} против {}", pa.get(k).unwrap_or(&Value::Null), pb.get(k).unwrap_or(&Value::Null)));
        }
    }
    if a["host"] != b["host"] {
        warn.push(format!("машина: {} против {}", a["host"], b["host"]));
    }
    let gap = (b["at"].as_i64().unwrap_or(0) - a["at"].as_i64().unwrap_or(0)).abs();
    if gap > 3600 {
        warn.push(format!("разрыв во времени {} ч — машина между прогонами могла остыть или нагреться", gap / 3600));
    }
    if !warn.is_empty() {
        println!("⚠ ПРОГОНЫ НЕ ОДИНАКОВЫ, разница выводов может быть не про код:");
        for w in &warn {
            println!("   · {w}");
        }
        println!();
    }

    let (ra, rb) = (a["rows"].as_array().cloned().unwrap_or_default(), b["rows"].as_array().cloned().unwrap_or_default());
    println!("{:>6}  {:>14}  {:>14}  {:>14}  {:>12}  {:>10}", "ботов", "кадры", "RTT p50, мс", "CPU сервера", "RSS, МБ", "тик");
    for row_a in &ra {
        let bots = row_a["bots"].as_u64().unwrap_or(0);
        let Some(row_b) = rb.iter().find(|r| r["bots"].as_u64() == Some(bots)) else { continue };
        let pair = |k: &str, scale: f64, unit_digits: usize| -> String {
            let (x, y) = (f(row_a, k) * scale, f(row_b, k) * scale);
            format!("{x:.*} → {y:.*}", unit_digits, unit_digits)
        };
        println!(
            "{:>6}  {:>14}  {:>14}  {:>14}  {:>12}  {:>10}",
            bots,
            pair("world", 1.0, 1),
            pair("p50", 1.0, 1),
            pair("srvCpu", 100.0, 0),
            pair("rss", 1.0, 0),
            pair("tick", 1.0, 1),
        );
    }

    let (ca, cb) = (a["capacity"].as_u64().unwrap_or(0), b["capacity"].as_u64().unwrap_or(0));
    if ca > 0 || cb > 0 {
        println!("\nЁМКОСТЬ: {ca} → {cb}{}", match cb.cmp(&ca) {
            std::cmp::Ordering::Greater => format!("  (+{:.0} %)", (cb as f64 / ca.max(1) as f64 - 1.0) * 100.0),
            std::cmp::Ordering::Less => format!("  (−{:.0} %)", (1.0 - cb as f64 / ca.max(1) as f64) * 100.0),
            std::cmp::Ordering::Equal => String::new(),
        });
    }
    let mis: u64 = rb.iter().filter_map(|r| r["mismatches"].as_u64()).sum();
    if mis > 0 {
        println!("⚠ в прогоне B расхождений дельт: {mis} — числа ниже этого не имеют значения");
    }
    Ok(())
}
