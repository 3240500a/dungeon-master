use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

/// Счётчики и гистограмма задержки.
///
/// Всё на атомиках без блокировок: тысячи задач пишут сюда на каждом кадре, и мьютекс здесь
/// стал бы точкой сборки, которая исказит ровно то, что мы измеряем.
///
/// ПОЧЕМУ ГИСТОГРАММА, А НЕ СПИСОК ЗАМЕРОВ. Прежний стенд считал перцентили по среднему
/// каждого бота — то есть по тысяче чисел вместо миллиона, и хвосты в нём тонули. Здесь
/// каждый замер попадает в корзину, и p99/p999 считаются по всем замерам, а не по средним.
/// Корзины по 0,25 мс до секунды: этого хватает и по точности, и по памяти (4096 счётчиков).
pub struct Stats {
    pub connected: AtomicU64,
    pub alive: AtomicU64,
    pub errors: AtomicU64,
    pub bytes_in: AtomicU64,
    pub bytes_out: AtomicU64,
    /// Двоичные кадры мира — по ним считается частота кадров у клиента.
    pub world_frames: AtomicU64,
    pub text_frames: AtomicU64,
    pub input_sent: AtomicU64,
    /// Сверки контрольной суммы (заполняется зрячими ботами, фаза С2).
    pub checks: AtomicU64,
    pub mismatches: AtomicU64,
    /// Возвращений в комнату после нарочного разрыва (сценарий реконнекта).
    pub reconnects: AtomicU64,
    rtt: Vec<AtomicU64>,
    rtt_over: AtomicU64,
    rtt_count: AtomicU64,
    rtt_sum_us: AtomicU64,
}

/// Ширина корзины в микросекундах и их число: 0…1024 мс.
const BUCKET_US: u64 = 250;
const BUCKETS: usize = 4096;

impl Stats {
    pub fn new() -> Self {
        Self {
            connected: AtomicU64::new(0),
            alive: AtomicU64::new(0),
            errors: AtomicU64::new(0),
            bytes_in: AtomicU64::new(0),
            bytes_out: AtomicU64::new(0),
            world_frames: AtomicU64::new(0),
            text_frames: AtomicU64::new(0),
            input_sent: AtomicU64::new(0),
            checks: AtomicU64::new(0),
            mismatches: AtomicU64::new(0),
            reconnects: AtomicU64::new(0),
            rtt: (0..BUCKETS).map(|_| AtomicU64::new(0)).collect(),
            rtt_over: AtomicU64::new(0),
            rtt_count: AtomicU64::new(0),
            rtt_sum_us: AtomicU64::new(0),
        }
    }

    pub fn add_rtt(&self, us: u64) {
        let idx = (us / BUCKET_US) as usize;
        if idx < BUCKETS {
            self.rtt[idx].fetch_add(1, Relaxed);
        } else {
            self.rtt_over.fetch_add(1, Relaxed);
        }
        self.rtt_count.fetch_add(1, Relaxed);
        self.rtt_sum_us.fetch_add(us, Relaxed);
    }

    /// Обнулить перед замером: прогрев в числа попадать не должен.
    pub fn reset(&self) {
        for c in [
            &self.errors, &self.bytes_in, &self.bytes_out, &self.world_frames,
            &self.text_frames, &self.input_sent, &self.checks, &self.mismatches, &self.reconnects,
            &self.rtt_over, &self.rtt_count, &self.rtt_sum_us,
        ] {
            c.store(0, Relaxed);
        }
        for b in &self.rtt {
            b.store(0, Relaxed);
        }
    }

    /// Перцентиль задержки в миллисекундах. `p` в долях: 0.5, 0.95, 0.99, 0.999.
    pub fn rtt_pct(&self, p: f64) -> f64 {
        let total = self.rtt_count.load(Relaxed);
        if total == 0 {
            return f64::NAN;
        }
        let target = (total as f64 * p).ceil() as u64;
        let mut seen = 0u64;
        for (i, b) in self.rtt.iter().enumerate() {
            seen += b.load(Relaxed);
            if seen >= target {
                // Середина корзины: честнее, чем нижняя граница.
                return (i as f64 * BUCKET_US as f64 + BUCKET_US as f64 / 2.0) / 1000.0;
            }
        }
        // Всё, что не влезло в корзины, — за пределом шкалы.
        1024.0
    }

    #[allow(dead_code)]
    pub fn rtt_mean_ms(&self) -> f64 {
        let n = self.rtt_count.load(Relaxed);
        if n == 0 {
            return f64::NAN;
        }
        self.rtt_sum_us.load(Relaxed) as f64 / n as f64 / 1000.0
    }

    pub fn rtt_n(&self) -> u64 {
        self.rtt_count.load(Relaxed)
    }
    pub fn rtt_over_scale(&self) -> u64 {
        self.rtt_over.load(Relaxed)
    }
}

/// Процессорное время СВОЕГО процесса, миллисекунды.
///
/// Стенд обязан знать, во что он сам обходится: если он вместе с сервером занял машину,
/// замер недостоверен, и лучше сказать об этом, чем показать красивое число.
#[cfg(windows)]
pub fn cpu_ms() -> f64 {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> isize;
        fn GetProcessTimes(h: isize, c: *mut u64, e: *mut u64, k: *mut u64, u: *mut u64) -> i32;
    }
    unsafe {
        let (mut c, mut e, mut k, mut u) = (0u64, 0u64, 0u64, 0u64);
        if GetProcessTimes(GetCurrentProcess(), &mut c, &mut e, &mut k, &mut u) == 0 {
            return 0.0;
        }
        (k + u) as f64 / 10_000.0 // единицы по 100 нс
    }
}

#[cfg(not(windows))]
pub fn cpu_ms() -> f64 {
    // На Linux пригодится /proc/self/stat; пока стенд живёт на Windows.
    0.0
}
