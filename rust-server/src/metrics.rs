use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    ffi::CString,
};
#[link(name = "System")]
unsafe extern "C" {
    fn sysctlbyname(
        name: *const libc::c_char,
        old: *mut libc::c_void,
        len: *mut usize,
        new: *mut libc::c_void,
        newlen: usize,
    ) -> libc::c_int;
    fn mach_host_self() -> u32;
    fn host_statistics(host: u32, flavor: i32, info: *mut i32, count: *mut u32) -> i32;
    fn mach_port_deallocate(task: u32, name: u32) -> i32;
    static mach_task_self_: u32;
}
fn sysctl<T: Default>(key: &str) -> Result<T, String> {
    let name = CString::new(key).map_err(|_| "invalid_data")?;
    let mut value = T::default();
    let mut size = std::mem::size_of::<T>();
    let code = unsafe {
        sysctlbyname(
            name.as_ptr(),
            &mut value as *mut T as *mut _,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if code != 0 || size != std::mem::size_of::<T>() {
        Err("unavailable".into())
    } else {
        Ok(value)
    }
}
#[repr(C)]
#[derive(Default)]
struct Swap {
    total: u64,
    available: u64,
    used: u64,
    page_size: u32,
    encrypted: u32,
}
pub struct Metrics {
    previous: Option<[u32; 4]>,
    high_since: Option<f64>,
    last_error: Option<Value>,
    failures: u64,
    pub value: Value,
    pub history: VecDeque<Value>,
}
impl Metrics {
    pub fn new() -> Self {
        Self {
            previous: None,
            high_since: None,
            last_error: None,
            failures: 0,
            value: json!({"status":"loading","observed_at":null,"cpu_percent":null}),
            history: VecDeque::new(),
        }
    }
    pub fn sample(&mut self) {
        let result = self.collect();
        match result {
            Ok(mut v) => {
                v["last_error"] = json!(self.last_error);
                v["consecutive_failures"] = json!(0);
                self.failures = 0;
                self.value = v;
                let at = (crate::now() / 10.).floor() * 10.;
                let point = json!({"at":at,"cpu_percent":self.value["cpu_percent"],"memory_percent":self.value["memory_percent"],"swap_used":self.value["swap_used"]});
                if self.history.back().is_some_and(|x| x["at"] == at) {
                    self.history.pop_back();
                }
                self.history.push_back(point);
                while self.history.len() > 180 {
                    self.history.pop_front();
                }
            }
            Err(reason) => {
                self.failures += 1;
                self.value["consecutive_failures"] = json!(self.failures);
                self.value["status"] = json!("unavailable");
                self.value["last_error"] = json!({"at":crate::now(),"stage":"system","reason":reason,"type":"RustMetricsError"});
                self.last_error = Some(self.value["last_error"].clone());
            }
        }
    }
    fn collect(&mut self) -> Result<Value, String> {
        let mut ticks = [0u32; 4];
        let mut count = 4u32;
        let host = unsafe { mach_host_self() };
        let result =
            unsafe { host_statistics(host, 3, ticks.as_mut_ptr() as *mut i32, &mut count) };
        unsafe { mach_port_deallocate(mach_task_self_, host) };
        if result != 0 {
            return Err("cpu_unavailable".into());
        }
        let cpu = self.previous.map(|p| {
            let delta: [u32; 4] = std::array::from_fn(|i| ticks[i].wrapping_sub(p[i]));
            let total = delta.iter().map(|x| *x as u64).sum::<u64>();
            if total == 0 {
                0.
            } else {
                ((total - delta[2] as u64) as f64 / total as f64 * 1000.).round() / 10.
            }
        });
        self.previous = Some(ticks);
        let total = sysctl::<u64>("hw.memsize")?;
        let pressure = sysctl::<i32>("kern.memorystatus_vm_pressure_level")?;
        let swap = sysctl::<Swap>("vm.swapusage")?;
        let mem = memory(&crate::bounded::text("/usr/bin/vm_stat", &[])?, total)?;
        let now = crate::now();
        if cpu.is_some_and(|x| x >= 85.) {
            if self.high_since.is_none() {
                self.high_since = Some(now)
            }
        } else {
            self.high_since = None
        }
        Ok(
            json!({"status":"ok","observed_at":now,"cpu_percent":cpu,"cpu_high":self.high_since.is_some_and(|x|now-x>=10.),"memory_used":mem,"memory_total":total,"memory_percent":(mem as f64/total as f64*1000.).round()/10.,"memory_pressure":match pressure{1=>"normal",2=>"warning",4=>"critical",_=>"unknown"},"swap_used":swap.used,"swap_total":swap.total,"last_error":null,"consecutive_failures":0}),
        )
    }
}
fn memory(raw: &str, total: u64) -> Result<u64, String> {
    let first = raw.lines().next().ok_or("invalid_data")?;
    let size = first
        .split("page size of ")
        .nth(1)
        .and_then(|s| s.split_whitespace().next())
        .and_then(|s| s.parse::<i64>().ok())
        .ok_or("invalid_data")?;
    let mut pages = HashMap::new();
    for line in raw.lines().skip(1) {
        if let Some((name, value)) = line.split_once(':') {
            if let Ok(n) = value.trim().trim_end_matches('.').parse::<i64>() {
                pages.insert(name, n);
            }
        }
    }
    let mut used = 0i64;
    for key in [
        "Pages active",
        "Pages inactive",
        "Pages wired down",
        "Pages occupied by compressor",
    ] {
        used += pages.get(key).ok_or("invalid_data")?;
    }
    for key in ["File-backed pages", "Pages purgeable"] {
        used -= pages.get(key).ok_or("invalid_data")?;
    }
    Ok((used.max(0) as u64).saturating_mul(size as u64).min(total))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn memory_shape() {
        let raw="Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages active: 10.\nPages inactive: 5.\nPages wired down: 2.\nPages occupied by compressor: 1.\nFile-backed pages: 4.\nPages purgeable: 1.\n";
        assert_eq!(memory(raw, 1000000).unwrap(), 13 * 16384);
        assert!(memory("invalid", 0).is_err());
    }
}
