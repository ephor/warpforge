use std::collections::HashMap;
use std::net::TcpListener;
use std::sync::{Mutex, OnceLock};

const PORT_BASE: u16 = 4000;
const PORT_RANGE_SIZE: u16 = 100;

fn alloc_map() -> &'static Mutex<HashMap<u16, String>> {
    static ALLOCATED: OnceLock<Mutex<HashMap<u16, String>>> = OnceLock::new();
    ALLOCATED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Returns the port range [start, start+99] for a given project index.
pub fn port_range(project_index: usize) -> (u16, u16) {
    let start = PORT_BASE + (project_index as u16) * PORT_RANGE_SIZE;
    (start, start + PORT_RANGE_SIZE - 1)
}

/// Check if a TCP port is available by trying to bind to it.
fn is_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Allocate the first available port in the project's range.
/// Returns `(original_port, allocated_port)`.
pub fn allocate(
    project_index: usize,
    project_name: &str,
    service_name: &str,
    _desired_port: u16,
) -> Result<u16, String> {
    let key = format!("{project_name}/{service_name}");
    let (start, end) = port_range(project_index);
    let mut map = alloc_map().lock().unwrap();

    for port in start..=end {
        if map.contains_key(&port) {
            continue;
        }
        if is_available(port) {
            map.insert(port, key);
            return Ok(port);
        }
    }

    Err(format!(
        "No available ports in range {start}-{end} for {project_name}/{service_name}"
    ))
}

/// Release the port allocated for a service.
pub fn release(project_name: &str, service_name: &str) {
    let key = format!("{project_name}/{service_name}");
    alloc_map().lock().unwrap().retain(|_, v| v != &key);
}

/// Release all ports for a project.
pub fn release_project(project_name: &str) {
    let prefix = format!("{project_name}/");
    alloc_map().lock().unwrap().retain(|_, v| !v.starts_with(&prefix));
}

/// Replace `${service.port}` placeholders in env values.
/// `port_map` maps service_name → allocated_port.
pub fn interpolate_env(
    env: &HashMap<String, String>,
    port_map: &HashMap<String, u16>,
) -> HashMap<String, String> {
    env.iter()
        .map(|(k, v)| {
            let replaced = regex_replace(v, port_map);
            (k.clone(), replaced)
        })
        .collect()
}

fn regex_replace(s: &str, port_map: &HashMap<String, u16>) -> String {
    let mut result = s.to_string();
    // Replace ${svcName.port} with the allocated port number
    // Simple manual scan — avoids pulling in the regex crate
    loop {
        if let Some(start) = result.find("${") {
            if let Some(end) = result[start..].find('}') {
                let placeholder = &result[start + 2..start + end];
                if let Some(svc) = placeholder.strip_suffix(".port") {
                    if let Some(&port) = port_map.get(svc) {
                        let full = format!("${{{}}}", placeholder);
                        result = result.replacen(&full, &port.to_string(), 1);
                        continue;
                    }
                }
            }
        }
        break;
    }
    result
}
