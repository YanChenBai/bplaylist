use crate::{CoreResult, SharedCore, invoke};
use serde_json::{Value, json};
use std::io::Read;
use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use subtle::ConstantTimeEq;
use tiny_http::{Header, Method, Response, Server, StatusCode};

struct Running {
    stop: Arc<AtomicBool>,
    address: String,
}
static SERVER: OnceLock<Mutex<Option<Running>>> = OnceLock::new();

pub fn configure(core: SharedCore, input: Value) -> CoreResult<Value> {
    let mut slot = SERVER
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "服务锁不可用")?;
    if input["enabled"] == false {
        if let Some(server) = slot.take() {
            server.stop.store(true, Ordering::Release);
        }
        return Ok(json!({"connected":false}));
    }
    if let Some(server) = slot.as_ref() {
        return Ok(
            json!({"connected":true,"address":server.address,"token":core.lock().map_err(|_|"数据库锁不可用")?.token()}),
        );
    }
    let host = if input["lan"] == true {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    };
    let port = input["port"].as_u64().unwrap_or(47821);
    if port > 65535 {
        return Err("服务端口无效".into());
    }
    let server = Server::http(format!("{host}:{port}")).map_err(|e| e.to_string())?;
    let address = server
        .server_addr()
        .to_ip()
        .ok_or("监听地址无效")?
        .to_string();
    let token = core.lock().map_err(|_| "数据库锁不可用")?.token();
    let secret = token.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let shutdown = stop.clone();
    std::thread::Builder::new()
        .name("bplaylist-http".into())
        .spawn(move || {
            while !shutdown.load(Ordering::Acquire) {
                let request = match server.recv_timeout(Duration::from_millis(100)) {
                    Ok(Some(r)) => r,
                    Ok(None) => continue,
                    Err(_) => break,
                };
                handle(request, &core, &secret);
            }
        })
        .map_err(|e| e.to_string())?;
    *slot = Some(Running {
        stop,
        address: address.clone(),
    });
    Ok(json!({"connected":true,"address":address,"token":token}))
}

fn handle(mut request: tiny_http::Request, core: &SharedCore, token: &str) {
    let header = |name: &str| {
        request
            .headers()
            .iter()
            .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
            .map(|h| h.value.as_str().to_owned())
    };
    let origin = header("origin");
    let permitted_origin = origin.as_deref().is_none_or(|o| {
        let Some(id) = o
            .strip_prefix("chrome-extension://")
            .or_else(|| o.strip_prefix("moz-extension://"))
        else {
            return false;
        };
        !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    });
    let authorization = header("authorization").unwrap_or_default();
    let authorized = authorization
        .strip_prefix("Bearer ")
        .is_some_and(|value| value.as_bytes().ct_eq(token.as_bytes()).into());
    let path = request
        .url()
        .split('?')
        .next()
        .unwrap_or_default()
        .to_owned();
    let error = if !permitted_origin {
        Some((403, "FORBIDDEN", "请求来源无效"))
    } else if !authorized {
        Some((401, "UNAUTHORIZED", "访问密钥无效"))
    } else if request.method() != &Method::Post {
        Some((405, "METHOD_NOT_SUPPORTED", "仅支持 POST"))
    } else if !["/rpc/list", "/rpc/groups", "/rpc/append"].contains(&path.as_str()) {
        Some((404, "NOT_FOUND", "接口不存在"))
    } else {
        None
    };
    let (status, body) = if let Some((status, code, message)) = error {
        (status, error_body(code, message))
    } else {
        let mut bytes = Vec::new();
        match request.as_reader().take(1_048_577).read_to_end(&mut bytes) {
            Ok(_) if bytes.len() > 1_048_576 => {
                (413, error_body("PAYLOAD_TOO_LARGE", "请求体超过限制"))
            }
            Ok(_) => match serde_json::from_slice::<Value>(&bytes) {
                Ok(envelope)
                    if envelope.get("meta").is_none()
                        || envelope["meta"].as_array().is_some_and(Vec::is_empty) =>
                {
                    match invoke(
                        core,
                        path.trim_start_matches("/rpc/"),
                        envelope["json"].clone(),
                    ) {
                        Ok(data) => (200, json!({"json":data})),
                        Err(message) => (400, error_body("BAD_REQUEST", &message)),
                    }
                }
                _ => (400, error_body("BAD_REQUEST", "请求格式无效")),
            },
            Err(_) => (400, error_body("BAD_REQUEST", "无法读取请求")),
        }
    };
    let mut response = Response::from_string(body.to_string()).with_status_code(StatusCode(status));
    for (name, value) in [
        ("Content-Type", "application/json"),
        ("Cache-Control", "no-store"),
    ] {
        if let Ok(header) = Header::from_bytes(name, value) {
            response.add_header(header);
        }
    }
    let _ = request.respond(response);
}

fn error_body(code: &str, message: &str) -> Value {
    json!({"json":{"defined":false,"code":code,"message":message}})
}
