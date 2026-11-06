use crate::CoreResult;
use serde_json::Value;
use std::collections::HashSet;
use url::Url;

pub struct Segment {
    pub url: String,
    pub start: f64,
    pub end: Option<f64>,
}

pub fn text(value: &Value) -> CoreResult<&str> {
    value
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or("文本不能为空".into())
}

fn bounded(value: &Value, max: usize) -> CoreResult<()> {
    if text(value)?.chars().count() > max {
        return Err("文本超过长度限制".into());
    }

    Ok(())
}

fn valid_url(value: &Value) -> CoreResult<()> {
    let source = text(value)?;
    let url = Url::parse(source).map_err(|_| "视频链接无效")?;
    let host = url.host_str().unwrap_or_default();
    let path = url.path();
    let valid_path = path.starts_with("/video/BV")
        || path.starts_with("/video/av")
        || path.starts_with("/bangumi/play/ep")
        || path.starts_with("/bangumi/play/ss");

    if source.len() > 2048
        || url.scheme() != "https"
        || !(host == "bilibili.com" || host.ends_with(".bilibili.com"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !valid_path
    {
        return Err("必须是 HTTPS B 站视频或番剧链接".into());
    }

    if url
        .query_pairs()
        .any(|(key, value)| key == "p" && value.parse::<u32>().map_or(true, |p| p == 0))
    {
        return Err("分 P 必须是正整数".into());
    }

    Ok(())
}

pub fn validate(document: &Value) -> CoreResult<()> {
    if document["version"] != 1 {
        return Err("播放列表版本无效".into());
    }
    bounded(&document["id"], 100)?;
    bounded(&document["title"], 200)?;
    let nodes = document["nodes"]
        .as_array()
        .filter(|n| n.len() <= 10000)
        .ok_or("列表条目无效")?;
    let mut ids = HashSet::new();

    for node in nodes {
        bounded(&node["id"], 100)?;
        bounded(&node["title"], 300)?;

        if !ids.insert(text(&node["id"])?) {
            return Err("条目 ID 重复".into());
        }
        let mut seen = HashSet::new();
        seen.insert(text(&node["id"])?);
        let mut parent = &node["parentId"];

        while !parent.is_null() {
            let id = text(parent)?;
            if !seen.insert(id) || seen.len() > 32 {
                return Err("分组循环或嵌套过深".into());
            }
            let p = nodes
                .iter()
                .find(|n| n["id"] == id && n["kind"] == "group")
                .ok_or("分组不存在")?;
            parent = &p["parentId"];
        }

        match node["kind"].as_str() {
            Some("group") => {}
            Some("video") => {
                valid_url(&node["url"])?;
                for key in ["alias", "partTitle"] {
                    if node[key].as_str().is_some_and(|s| s.chars().count() > 300) {
                        return Err("视频名称过长".into());
                    }
                }

                if let Some(offset) = node.get("audioOffsetMs") {
                    if !offset.as_i64().is_some_and(|value| (-10000..=10000).contains(&value)) {
                        return Err("声音偏移必须为 -10000 到 10000 之间的整数毫秒".into());
                    }
                }

                let start = node["start"]
                    .as_f64()
                    .filter(|n| n.is_finite() && *n >= 0.0)
                    .ok_or("开始时间无效")?;
                let end = if node["end"].is_null() {
                    None
                } else {
                    Some(
                        node["end"]
                            .as_f64()
                            .filter(|n| n.is_finite() && *n >= 0.0)
                            .ok_or("结束时间无效")?,
                    )
                };

                if let Some(parts) = node.get("continuation") {
                    let parts = parts
                        .as_array()
                        .filter(|p| !p.is_empty() && p.len() <= 10000)
                        .ok_or("跨分集范围无效")?;
                    let mut sources = HashSet::from([identity(text(&node["url"])?)]);

                    for part in parts {
                        valid_url(&part["url"])?;
                        if !sources.insert(identity(text(&part["url"])?)) {
                            return Err("跨分集不能包含重复分集".into());
                        }
                    }
                } else if end.is_some_and(|end| end <= start) {
                    return Err("结束时间必须大于开始时间".into());
                }
            }
            _ => return Err("未知播放条目".into()),
        }
    }

    if !document["activeItemId"].is_null()
        && !nodes
            .iter()
            .any(|n| n["id"] == document["activeItemId"] && n["kind"] == "video")
    {
        return Err("当前视频不存在".into());
    }
    let progress = document["progress"].as_object().ok_or("播放进度无效")?;

    for (id, p) in progress {
        if !nodes
            .iter()
            .any(|n| n["id"] == id.as_str() && n["kind"] == "video")
        {
            return Err("进度引用不存在的视频".into());
        }
        for key in ["position", "duration"] {
            if !p[key].as_f64().is_some_and(|v| v.is_finite() && v >= 0.0) {
                return Err("播放进度无效".into());
            }
        }
        if !p["completed"].is_boolean() {
            return Err("完成状态无效".into());
        }
    }
    Ok(())
}

pub fn prune_progress(document: &mut Value) {
    let valid: HashSet<String> = document["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|n| n["kind"] == "video")
        .filter_map(|n| n["id"].as_str().map(str::to_owned))
        .collect();
    if let Some(progress) = document["progress"].as_object_mut() {
        progress.retain(|id, _| valid.contains(id));
    }
    if document["activeItemId"]
        .as_str()
        .is_some_and(|id| !valid.contains(id))
    {
        document["activeItemId"] = Value::Null;
    }
}

pub fn identity(value: &str) -> String {
    let Ok(url) = Url::parse(value) else {
        return value.into();
    };
    let page = url
        .query_pairs()
        .find(|(k, _)| k == "p")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_else(|| "1".into());
    format!("{}?p={page}", url.path().trim_end_matches('/'))
}

pub fn segments(item: &Value) -> Vec<Segment> {
    let mut urls = vec![item["url"].as_str().unwrap_or_default().to_owned()];
    urls.extend(
        item["continuation"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| p["url"].as_str().map(str::to_owned)),
    );
    let last = urls.len() - 1;
    urls.into_iter()
        .enumerate()
        .map(|(index, url)| Segment {
            url,
            start: if index == 0 {
                item["start"].as_f64().unwrap_or(0.0)
            } else {
                0.0
            },
            end: if index == last {
                item["end"].as_f64()
            } else {
                None
            },
        })
        .collect()
}

pub fn flatten(nodes: &Value, parent: &Value, output: &mut Vec<Value>) {
    for node in nodes
        .as_array()
        .into_iter()
        .flatten()
        .filter(|n| &n["parentId"] == parent)
    {
        if node["kind"] == "group" {
            flatten(nodes, &node["id"], output)
        } else {
            output.push(node["id"].clone())
        }
    }
}
