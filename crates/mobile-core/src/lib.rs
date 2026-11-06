mod model;
mod server;

use chrono::{SecondsFormat, Utc};
use rand::RngCore;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex, OnceLock};
use uuid::Uuid;

fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub type CoreResult<T> = Result<T, String>;
pub type SharedCore = Arc<Mutex<Core>>;

pub struct Core {
    db: Connection,
    selected: String,
    playing: Option<String>,
    item: Option<String>,
    segment: usize,
    snapshot: Value,
    pending: Option<Value>,
    awaiting: bool,
    tracking: bool,
    revision: u64,
    session_started_at: String,
}

impl Core {
    pub fn open(path: &str) -> CoreResult<Self> {
        let db = Connection::open(path).map_err(|e| e.to_string())?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS playlists (
                 id TEXT PRIMARY KEY,
                 document TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS settings (
                 key TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );",
        )
        .map_err(|error| error.to_string())?;

        let mut core = Self {
            db,
            selected: String::new(),
            playing: None,
            item: None,
            segment: 0,
            snapshot: json!({}),
            pending: None,
            awaiting: false,
            tracking: false,
            revision: 0,
            session_started_at: timestamp(),
        };
        let lists = core.list()?;

        core.selected = match lists.first().and_then(|p| p["id"].as_str()) {
            Some(id) => id.to_owned(),
            None => core.create("我的播放列表")?["id"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        };
        let selected = core.setting("selected").unwrap_or_default();

        if core.document(&selected).is_ok() {
            core.selected = selected;
        }

        if core.setting("token").is_none() {
            let mut bytes = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut bytes);
            core.set_setting(
                "token",
                &bytes.iter().map(|b| format!("{b:02x}")).collect::<String>(),
            )?;
        }

        Ok(core)
    }

    pub fn token(&self) -> String {
        self.setting("token").unwrap_or_default()
    }

    fn setting(&self, key: &str) -> Option<String> {
        self.db
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .ok()
    }

    fn set_setting(&self, key: &str, value: &str) -> CoreResult<()> {
        self.db
            .execute(
                "INSERT OR REPLACE INTO settings(key,value) VALUES(?1,?2)",
                params![key, value],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn document(&self, id: &str) -> CoreResult<Value> {
        let text: String = self
            .db
            .query_row("SELECT document FROM playlists WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .map_err(|_| "播放列表不存在".to_owned())?;

        serde_json::from_str(&text).map_err(|e| e.to_string())
    }

    fn save(&mut self, document: &Value) -> CoreResult<()> {
        model::validate(document)?;
        self.db
            .execute(
                "INSERT INTO playlists(id,document) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET document=excluded.document",
                params![document["id"].as_str(), document.to_string()],
            )
            .map_err(|e| e.to_string())?;

        self.revision += 1;
        Ok(())
    }

    fn create(&mut self, title: &str) -> CoreResult<Value> {
        let document = json!({
            "version": 1,
            "id": Uuid::new_v4().to_string(),
            "title": title,
            "nodes": [],
            "activeItemId": null,
            "progress": {},
            "updatedAt": timestamp(),
        });

        self.save(&document)?;

        Ok(document)
    }

    fn list(&self) -> CoreResult<Vec<Value>> {
        let mut statement = self
            .db
            .prepare("SELECT document FROM playlists ORDER BY rowid")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut output = Vec::new();

        for row in rows {
            let p: Value = serde_json::from_str(&row.map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            output.push(json!({"id":p["id"],"title":p["title"],"active":p["id"] == self.selected}));
        }

        Ok(output)
    }

    fn state(&self) -> CoreResult<Value> {
        Ok(json!({
            "playlist": self.document(&self.selected)?,
            "playlists": self.list()?,
            "playingPlaylistId": self.playing,
            "playingItemId": self.item,
            "segmentIndex": self.segment,
            "snapshot": self.snapshot,
            "revision": self.revision,
            "theme": self.setting("theme").unwrap_or_else(|| "dark".into()),
            "autoFullscreen": self.setting("autoFullscreen").as_deref() != Some("false"),
        }))
    }

    pub fn dispatch(&mut self, method: &str, input: Value) -> CoreResult<Value> {
        match method {
            "syncDocuments" => {
                let documents = self
                    .list()?
                    .iter()
                    .map(|list| self.document(model::text(&list["id"])?))
                    .collect::<CoreResult<Vec<_>>>()?;
                Ok(json!(documents))
            }
            "syncCheckpoint" => {
                let key = model::text(&input)?;
                if !key.starts_with("sync:v2:") {
                    return Err("同步存储键无效".into());
                }
                Ok(json!(self.setting(key)))
            }
            "syncCommit" => self.sync_commit(input),
            "state" => self.state(),
            "list" => Ok(json!(self.list()?)),
            "groups" => Ok(json!(
                self.document(model::text(&input)?)?["nodes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|n| n["kind"] == "group")
                    .map(|n| json!({"id":n["id"],"title":n["title"]}))
                    .collect::<Vec<_>>()
            )),
            "select" => {
                let id = model::text(&input)?.to_owned();
                self.document(&id)?;
                self.set_setting("selected", &id)?;
                self.selected = id;

                self.state()
            }
            "create" => {
                let document = self.create(model::text(&input)?)?;
                self.selected = document["id"].as_str().unwrap_or_default().to_owned();
                self.set_setting("selected", &self.selected)?;

                self.state()
            }
            "save" => {
                let mut document = input;
                // 编辑器不能用旧快照覆盖刚刚保存的播放进度。
                let current = self.document(model::text(&document["id"])?)?;
                document["progress"] = current["progress"].clone();
                document["activeItemId"] = current["activeItemId"].clone();
                model::prune_progress(&mut document);
                document["updatedAt"] = json!(timestamp());
                self.save(&document)?;

                self.state()
            }
            "append" => {
                let id = model::text(&input["playlistId"])?;
                let nodes = input["nodes"]
                    .as_array()
                    .filter(|n| !n.is_empty() && n.len() <= 1000)
                    .ok_or("添加条目数量无效")?;
                let mut document = self.document(id)?;
                let current = document["nodes"].as_array().ok_or("列表数据无效")?;

                if nodes.iter().all(|n| current.iter().any(|old| old == n)) {
                    return Ok(json!({"added":0,"playlistId":id}));
                }
                if nodes
                    .iter()
                    .any(|n| current.iter().any(|old| old["id"] == n["id"]))
                {
                    return Err("条目已存在，请勿重复添加".into());
                }

                document["nodes"]
                    .as_array_mut()
                    .ok_or("列表数据无效")?
                    .extend(nodes.iter().cloned());
                document["updatedAt"] = json!(timestamp());
                self.save(&document)?;
                Ok(json!({"added":nodes.len(),"playlistId":id}))
            }
            "remove" => {
                let id = model::text(&input)?;
                self.document(id)?;
                self.db
                    .execute("DELETE FROM playlists WHERE id=?1", [id])
                    .map_err(|e| e.to_string())?;
                if self.playing.as_deref() == Some(id) {
                    self.playing = None;
                    self.item = None;
                    self.tracking = false;
                    self.pending = Some(json!({"action":"pause"}));
                }
                if self.selected == id {
                    let lists = self.list()?;
                    self.selected = match lists.first() {
                        Some(p) => model::text(&p["id"])?.to_owned(),
                        None => model::text(&self.create("我的播放列表")?["id"])?.to_owned(),
                    };
                    self.set_setting("selected", &self.selected)?;
                }

                self.revision += 1;

                self.state()
            }
            "import" => {
                if input["format"] != "bplaylist" || input["version"] != 1 {
                    return Err("播放列表文件格式无效".into());
                }
                let mut document = input["playlist"].clone();
                document["id"] = json!(Uuid::new_v4().to_string());
                self.save(&document)?;
                self.selected = model::text(&document["id"])?.to_owned();
                self.set_setting("selected", &self.selected)?;

                self.state()
            }
            "export" => Ok(
                json!({"format":"bplaylist","version":1,"playlist":self.document(&self.selected)?}),
            ),
            "play" => {
                let id = model::text(&input)?.to_owned();
                let document = self.document(&self.selected)?;
                if !document["nodes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|n| n["id"] == id && n["kind"] == "video")
                {
                    return Err("视频不存在".into());
                }
                self.playing = Some(self.selected.clone());
                self.session_started_at = timestamp();
                self.item = Some(id.clone());
                self.segment = if document["progress"][&id]["completed"] == true {
                    0
                } else {
                    document["progress"][&id]["segmentIndex"]
                        .as_u64()
                        .unwrap_or(0) as usize
                };
                self.queue_navigation(true)?;

                self.state()
            }
            "next" | "previous" => {
                self.step(if method == "next" { 1 } else { -1 })?;

                self.state()
            }
            "resume" | "pause" => {
                if method == "resume" {
                    self.session_started_at = timestamp();
                }
                self.pending = Some(json!({"action":method}));
                Ok(Value::Null)
            }
            "seek" => {
                self.session_started_at = timestamp();
                let position = input
                    .as_f64()
                    .filter(|v| v.is_finite() && *v >= 0.0)
                    .ok_or("播放位置无效")?;
                self.pending = Some(json!({"action":"seek","position":position}));
                Ok(Value::Null)
            }
            "snapshot" => {
                self.update_snapshot(input)?;
                Ok(self.pending.take().unwrap_or(Value::Null))
            }
            "command" => Ok(self.pending.take().unwrap_or(Value::Null)),
            "setting" => {
                let key = model::text(&input["key"])?;
                if !["theme", "autoFullscreen", "remoteEndpoint", "remoteToken"].contains(&key) {
                    return Err("未知设置".into());
                }
                self.set_setting(key, model::text(&input["value"])?)?;

                self.state()
            }
            _ => Err("接口不存在".into()),
        }
    }

    fn sync_commit(&mut self, input: Value) -> CoreResult<Value> {
        let key = model::text(&input["key"])?;
        if !key.starts_with("sync:v2:") {
            return Err("同步存储键无效".into());
        }
        let mut updates = input["updates"].as_array().ok_or("同步更新无效")?.clone();
        let mut stop_playing = false;

        for update in &mut updates {
            let id = model::text(&update["id"])?.to_owned();
            let document = &mut update["playlist"];
            if document.is_null() {
                stop_playing |= self.playing.as_deref() == Some(&id);
                continue;
            }
            if document["id"] != id {
                return Err("同步列表 ID 不匹配".into());
            }

            if self.playing.as_deref() == Some(&id) && self.tracking {
                let current = self.document(&id)?;
                let item_id = self.item.as_deref().unwrap_or_default();
                let before = current["nodes"]
                    .as_array()
                    .and_then(|nodes| nodes.iter().find(|node| node["id"] == item_id));
                let after = document["nodes"]
                    .as_array()
                    .and_then(|nodes| nodes.iter().find(|node| node["id"] == item_id));
                let same_source = before.zip(after).is_some_and(|(a, b)| {
                    ["url", "start", "end", "continuation"]
                        .iter()
                        .all(|field| a[field] == b[field])
                });

                if same_source {
                    document["activeItemId"] = current["activeItemId"].clone();
                    if !current["progress"][item_id].is_null() {
                        document["progress"][item_id] = current["progress"][item_id].clone();
                    }
                } else {
                    stop_playing = true;
                }
            }
            model::validate(document)?;
        }

        let transaction = self.db.transaction().map_err(|error| error.to_string())?;
        for update in &updates {
            let id = model::text(&update["id"])?;
            if update["playlist"].is_null() {
                transaction.execute("DELETE FROM playlists WHERE id=?1", [id])
            } else {
                transaction.execute("INSERT INTO playlists(id,document) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET document=excluded.document",
                    params![id, update["playlist"].to_string()])
            }.map_err(|error| error.to_string())?;
        }
        transaction
            .execute(
                "INSERT OR REPLACE INTO settings(key,value) VALUES(?1,?2)",
                params![key, input["checkpoint"].to_string()],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;

        if stop_playing {
            self.playing = None;
            self.item = None;
            self.tracking = false;
            self.awaiting = false;
            self.pending = Some(json!({"action":"pause"}));
        }
        if self.document(&self.selected).is_err() {
            self.selected = match self.list()?.first() {
                Some(list) => model::text(&list["id"])?.to_owned(),
                None => model::text(&self.create("我的播放列表")?["id"])?.to_owned(),
            };
            self.set_setting("selected", &self.selected)?;
        }
        if !updates.is_empty() {
            self.revision += 1;
        }
        Ok(Value::Null)
    }

    fn playing_document(&self) -> CoreResult<Value> {
        self.document(self.playing.as_deref().ok_or("尚未播放列表")?)
    }

    fn queue_navigation(&mut self, resume: bool) -> CoreResult<()> {
        let mut document = self.playing_document()?;
        let id = self.item.as_deref().ok_or("尚未选择视频")?;
        let item = document["nodes"]
            .as_array()
            .and_then(|n| n.iter().find(|n| n["id"] == id))
            .ok_or("视频不存在")?;
        let segments = model::segments(item);

        self.segment = self.segment.min(segments.len().saturating_sub(1));
        let segment = &segments[self.segment];
        let start = if resume && document["progress"][id]["completed"] != true {
            document["progress"][id]["position"]
                .as_f64()
                .unwrap_or(segment.start)
                .max(segment.start)
        } else {
            segment.start
        };
        self.pending = Some(json!({
            "action": "navigate",
            "url": segment.url,
            "start": start,
            "end": segment.end,
            "autoFullscreen": self.setting("autoFullscreen").as_deref() != Some("false"),
        }));
        self.awaiting = true;
        self.tracking = true;

        document["activeItemId"] = json!(id);
        self.save(&document)
    }

    fn step(&mut self, direction: i32) -> CoreResult<()> {
        let document = self.playing_document()?;
        let mut queue = Vec::new();
        model::flatten(&document["nodes"], &Value::Null, &mut queue);

        let current = queue
            .iter()
            .position(|n| Some(n.as_str().unwrap_or_default()) == self.item.as_deref())
            .ok_or("尚未选择视频")?;
        let next = current as i32 + direction;

        if next < 0 || next >= queue.len() as i32 {
            self.tracking = false;
            self.pending = Some(json!({"action":"pause"}));
            return Ok(());
        }
        self.item = queue[next as usize].as_str().map(str::to_owned);
        self.session_started_at = timestamp();
        self.segment = 0;

        self.queue_navigation(false)
    }

    fn update_snapshot(&mut self, snapshot: Value) -> CoreResult<()> {
        self.snapshot = snapshot.clone();

        if !self.tracking || snapshot["available"] != true {
            return Ok(());
        }
        let mut document = self.playing_document()?;
        let id = self.item.clone().ok_or("视频不存在")?;
        let item = match document["nodes"]
            .as_array()
            .and_then(|n| n.iter().find(|n| n["id"] == id))
        {
            Some(n) => n,
            None => return Ok(()),
        };
        let segments = model::segments(item);

        let Some(segment) = segments.get(self.segment) else {
            return Ok(());
        };

        if model::identity(snapshot["url"].as_str().unwrap_or_default())
            != model::identity(&segment.url)
        {
            return Ok(());
        }

        if snapshot["seeking"] == true {
            return Ok(());
        }

        let position = snapshot["position"]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0)
            .unwrap_or(0.0);

        if self.awaiting {
            if position + 1.0 < segment.start {
                return Ok(());
            }
            self.awaiting = false;
        }

        let ended = snapshot["ended"] == true || segment.end.is_some_and(|end| position >= end);
        let completed = ended && self.segment + 1 >= segments.len();

        document["progress"][&id] = json!({
            "sessionStartedAt": self.session_started_at,
            "segmentIndex": self.segment,
            "position": position,
            "duration": snapshot["duration"].as_f64().unwrap_or(0.0),
            "completed": completed,
            "updatedAt": timestamp(),
        });
        document["updatedAt"] = json!(timestamp());
        self.save(&document)?;

        if ended {
            if !completed {
                self.segment += 1;
                self.queue_navigation(false)?;
            } else {
                self.step(1)?;
            }
        }

        Ok(())
    }
}

pub fn invoke(core: &SharedCore, method: &str, input: Value) -> CoreResult<Value> {
    core.lock()
        .map_err(|_| "数据库锁不可用".to_owned())?
        .dispatch(method, input)
}

static CORE: OnceLock<SharedCore> = OnceLock::new();

pub fn call(method: &str, payload: &str) -> String {
    let result = (|| -> CoreResult<Value> {
        let input: Value = serde_json::from_str(payload).map_err(|e| e.to_string())?;
        if method == "open" {
            if CORE.get().is_none() {
                let core = Core::open(model::text(&input)?)?;
                let _ = CORE.set(Arc::new(Mutex::new(core)));
            }
            return invoke(CORE.get().ok_or("初始化失败")?, "state", Value::Null);
        }
        let core = CORE.get().ok_or("尚未初始化")?;
        if method == "server" {
            return server::configure(core.clone(), input);
        }
        invoke(core, method, input)
    })();
    match result {
        Ok(data) => json!({"ok":true,"data":data}),
        Err(error) => json!({"ok":false,"error":error}),
    }
    .to_string()
}

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_bplaylist_mobile_NativeCore_call(
    mut env: jni::JNIEnv,
    _class: jni::objects::JClass,
    method: jni::objects::JString,
    payload: jni::objects::JString,
) -> jni::sys::jstring {
    let result = (|| -> CoreResult<String> {
        let method: String = env.get_string(&method).map_err(|e| e.to_string())?.into();
        let payload: String = env.get_string(&payload).map_err(|e| e.to_string())?.into();
        Ok(call(&method, &payload))
    })();
    let output = result.unwrap_or_else(|error| json!({"ok":false,"error":error}).to_string());
    match env.new_string(output) {
        Ok(s) => s.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

#[cfg(test)]
mod sync_tests {
    use super::*;

    #[test]
    fn sync_should_keep_remote_ids_and_selected_playlist() {
        let mut core = Core::open(":memory:").expect("open test database");
        let selected = core.selected.clone();
        let remote = json!({"version":1,"id":"remote","title":"云端列表","nodes":[],"activeItemId":null,"progress":{},"updatedAt":timestamp()});
        core.dispatch("syncCommit", json!({"key":"sync:v2:test","checkpoint":{"cursor":1},"updates":[{"id":"remote","playlist":remote}]})).expect("commit sync");
        assert_eq!(core.selected, selected);
        assert_eq!(
            core.document("remote").expect("remote playlist")["id"],
            "remote"
        );
        assert_eq!(
            core.dispatch("syncCheckpoint", json!("sync:v2:test"))
                .expect("checkpoint"),
            "{\"cursor\":1}"
        );
    }

    #[test]
    fn invalid_sync_should_not_partially_save_documents_or_cursor() {
        let mut core = Core::open(":memory:").expect("open test database");
        let remote = json!({"version":1,"id":"remote","title":"云端列表","nodes":[],"activeItemId":null,"progress":{},"updatedAt":timestamp()});
        let result = core.dispatch("syncCommit", json!({"key":"sync:v2:test","checkpoint":{"cursor":2},"updates":[{"id":"remote","playlist":remote},{"id":"other","playlist":{"id":"wrong"}}]}));
        assert!(result.is_err());
        assert!(core.document("remote").is_err());
        assert_eq!(core.setting("sync:v2:test"), None);
    }

    #[test]
    fn sync_deletion_should_stop_playback_and_keep_valid_selection() {
        let mut core = Core::open(":memory:").expect("open test database");
        let id = core.selected.clone();
        core.playing = Some(id.clone());
        core.tracking = true;
        core.dispatch("syncCommit", json!({"key":"sync:v2:test","checkpoint":{"cursor":3},"updates":[{"id":id,"playlist":null}]})).expect("delete synced playlist");
        assert!(core.playing.is_none());
        assert_ne!(core.selected, id);
        assert!(core.document(&core.selected).is_ok());
    }
}
