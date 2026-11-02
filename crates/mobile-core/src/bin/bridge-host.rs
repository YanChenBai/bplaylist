use bplaylist_mobile::call;
use serde_json::json;
use std::io::{BufRead, Write};

fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "bplaylist-mobile.sqlite".into());
    println!("{}", call("open", &json!(path).to_string()));
    println!(
        "{}",
        call(
            "server",
            &json!({"enabled":true,"lan":false,"port":47822}).to_string()
        )
    );
    let _ = std::io::stdout().flush();

    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(request) = serde_json::from_str::<serde_json::Value>(&line) else {
            break;
        };
        let Some(method) = request["method"].as_str() else {
            break;
        };

        println!("{}", call(method, &request["input"].to_string()));
        let _ = std::io::stdout().flush();
    }
}
