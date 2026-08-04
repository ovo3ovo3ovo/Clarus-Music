use std::collections::BTreeMap;

use keyring::{Entry, Error as KeyringError};
use ncm_api_rs::{ApiResponse, Query};
use serde::Serialize;
use serde_json::Value;
use tauri::State;
use zeroize::Zeroizing;

use crate::music_api::{ApiFailure, MusicApiState};

const KEYRING_SERVICE: &str = "com.ovo3ovo3ovo.clarusmusic";
const KEYRING_ACCOUNT: &str = "netease-session";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrLogin {
    key: String,
    login_url: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum QrLoginStatus {
    Waiting,
    Scanned,
    Authorized,
    Expired,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrLoginCheck {
    status: QrLoginStatus,
    message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    user_id: i64,
    nickname: String,
    avatar_url: String,
    signature: String,
    vip_type: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    authenticated: bool,
    user: Option<AuthUser>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogoutResult {
    remote_logout_succeeded: bool,
}

fn keyring_entry() -> Result<Entry, ApiFailure> {
    Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|error| {
        ApiFailure::secure_storage(format!(
            "Failed to open the system credential store: {error}"
        ))
    })
}

fn load_credential() -> Result<Option<String>, ApiFailure> {
    match keyring_entry()?.get_password() {
        Ok(cookie) => Ok(Some(cookie)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(ApiFailure::secure_storage(format!(
            "Failed to read the saved session: {error}"
        ))),
    }
}

fn save_credential(cookie: &str) -> Result<(), ApiFailure> {
    keyring_entry()?.set_password(cookie).map_err(|error| {
        ApiFailure::secure_storage(format!("Failed to save the session securely: {error}"))
    })
}

fn delete_credential() -> Result<(), ApiFailure> {
    match keyring_entry()?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(ApiFailure::secure_storage(format!(
            "Failed to remove the saved session: {error}"
        ))),
    }
}

fn response_code(body: &Value) -> i64 {
    body.get("code")
        .and_then(|code| {
            code.as_i64()
                .or_else(|| code.as_str().and_then(|value| value.parse().ok()))
        })
        .unwrap_or_default()
}

fn response_message(body: &Value, fallback: &str) -> String {
    body.get("message")
        .or_else(|| body.get("msg"))
        .and_then(Value::as_str)
        .filter(|message| !message.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn insert_cookie_pairs(cookies: &mut BTreeMap<String, String>, source: &str) {
    const ATTRIBUTES: &[&str] = &[
        "domain",
        "expires",
        "httponly",
        "max-age",
        "partitioned",
        "path",
        "samesite",
        "secure",
    ];

    for segment in source.replace(";;", ";").split(';') {
        let segment = segment.trim();
        let Some((name, value)) = segment.split_once('=') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty()
            || name.len() > 128
            || ATTRIBUTES.contains(&name.to_ascii_lowercase().as_str())
        {
            continue;
        }
        let value = value.trim();
        if value.len() <= 8192 {
            cookies.insert(name.to_string(), value.to_string());
        }
    }
}

fn authenticated_cookie(response: &ApiResponse) -> Result<String, ApiFailure> {
    let mut cookies = BTreeMap::new();
    if let Some(cookie) = response.body.get("cookie").and_then(Value::as_str) {
        insert_cookie_pairs(&mut cookies, cookie);
    }
    for cookie in &response.cookie {
        insert_cookie_pairs(&mut cookies, cookie);
    }

    if !cookies.contains_key("MUSIC_U") {
        return Err(ApiFailure::secure_storage(
            "The login response did not contain an authenticated session",
        ));
    }

    Ok(cookies
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; "))
}

fn value_i64(value: &Value, key: &str) -> i64 {
    value
        .get(key)
        .and_then(|candidate| {
            candidate
                .as_i64()
                .or_else(|| candidate.as_str().and_then(|text| text.parse().ok()))
        })
        .unwrap_or_default()
}

fn value_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn auth_user(body: &Value) -> Option<AuthUser> {
    let data = body.get("data").unwrap_or(body);
    let profile = data.get("profile").or_else(|| body.get("profile"))?;
    let user_id = value_i64(profile, "userId");
    let nickname = value_string(profile, "nickname");
    if user_id <= 0 || nickname.is_empty() {
        return None;
    }
    Some(AuthUser {
        user_id,
        nickname,
        avatar_url: value_string(profile, "avatarUrl"),
        signature: value_string(profile, "signature"),
        vip_type: value_i64(profile, "vipType"),
    })
}

fn qr_login_key(body: &Value) -> Option<&str> {
    body.get("data")
        .and_then(|data| data.get("unikey"))
        .or_else(|| body.get("unikey"))
        .and_then(Value::as_str)
        .filter(|key| !key.is_empty())
}

fn request_query(mut query: Query, cookie: &Option<String>, real_ip: Option<String>) -> Query {
    if let Some(cookie) = cookie {
        query = query.cookie(cookie);
    }
    query.real_ip = real_ip;
    query
}

#[tauri::command]
pub async fn begin_qr_login(
    request_id: String,
    state: State<'_, MusicApiState>,
) -> Result<QrLogin, ApiFailure> {
    let (client, _, real_ip) = state.request_context().await;
    state
        .run_cancellable(request_id, async move {
            let response = client
                .login_qr_key(&request_query(Query::new(), &None, real_ip))
                .await
                .map_err(ApiFailure::from_ncm)?;
            let key = qr_login_key(&response.body)
                .ok_or_else(|| ApiFailure::invalid("The QR login key was missing"))?
                .to_string();
            Ok(QrLogin {
                login_url: format!("https://music.163.com/login?codekey={key}"),
                key,
            })
        })
        .await
}

#[tauri::command]
pub async fn check_qr_login(
    request_id: String,
    key: String,
    state: State<'_, MusicApiState>,
) -> Result<QrLoginCheck, ApiFailure> {
    if key.is_empty() || key.len() > 512 {
        return Err(ApiFailure::invalid(
            "key must contain between 1 and 512 bytes",
        ));
    }
    let (client, _, real_ip) = state.request_context().await;
    let session = state.session_handle();
    state
        .run_cancellable(request_id, async move {
            let response = client
                .login_qr_check(&request_query(
                    Query::new().param("key", &key),
                    &None,
                    real_ip,
                ))
                .await
                .map_err(ApiFailure::from_ncm)?;
            let code = response_code(&response.body);
            let (status, fallback) = match code {
                800 => (QrLoginStatus::Expired, "QR code expired"),
                802 => (
                    QrLoginStatus::Scanned,
                    "QR code scanned; confirm login on your device",
                ),
                803 => (QrLoginStatus::Authorized, "Login authorized"),
                _ => (QrLoginStatus::Waiting, "Waiting for QR code scan"),
            };

            if code == 803 {
                let cookie = Zeroizing::new(authenticated_cookie(&response)?);
                let stored_cookie = cookie.to_string();
                tokio::task::spawn_blocking(move || save_credential(&stored_cookie))
                    .await
                    .map_err(|error| ApiFailure::secure_storage(error.to_string()))??;
                *session.write().await = Some(cookie);
            }

            Ok(QrLoginCheck {
                status,
                message: response_message(&response.body, fallback),
            })
        })
        .await
}

#[tauri::command]
pub async fn restore_session(
    request_id: String,
    state: State<'_, MusicApiState>,
) -> Result<AuthSession, ApiFailure> {
    let (client, _, real_ip) = state.request_context().await;
    let session = state.session_handle();
    state
        .run_cancellable(request_id, async move {
            let cookie = tokio::task::spawn_blocking(load_credential)
                .await
                .map_err(|error| ApiFailure::secure_storage(error.to_string()))??;
            let Some(cookie) = cookie else {
                *session.write().await = None;
                return Ok(AuthSession {
                    authenticated: false,
                    user: None,
                });
            };

            let response = client
                .login_status(&request_query(Query::new(), &Some(cookie.clone()), real_ip))
                .await
                .map_err(ApiFailure::from_ncm)?;
            let user = auth_user(&response.body);
            if user.is_some() {
                *session.write().await = Some(Zeroizing::new(cookie));
            } else {
                *session.write().await = None;
                tokio::task::spawn_blocking(delete_credential)
                    .await
                    .map_err(|error| ApiFailure::secure_storage(error.to_string()))??;
            }
            Ok(AuthSession {
                authenticated: user.is_some(),
                user,
            })
        })
        .await
}

#[tauri::command]
pub async fn logout(
    request_id: String,
    state: State<'_, MusicApiState>,
) -> Result<LogoutResult, ApiFailure> {
    let (client, cookie, real_ip) = state.request_context().await;
    let session = state.session_handle();
    state
        .run_cancellable(request_id, async move {
            let remote_logout_succeeded = match cookie {
                Some(cookie) => client
                    .logout(&request_query(Query::new(), &Some(cookie), real_ip))
                    .await
                    .is_ok(),
                None => true,
            };
            *session.write().await = None;
            tokio::task::spawn_blocking(delete_credential)
                .await
                .map_err(|error| ApiFailure::secure_storage(error.to_string()))??;
            Ok(LogoutResult {
                remote_logout_succeeded,
            })
        })
        .await
}

#[cfg(test)]
mod tests {
    use ncm_api_rs::{create_client, ApiResponse, Query};
    use serde_json::json;

    use super::{auth_user, authenticated_cookie, qr_login_key, QrLoginStatus};

    #[test]
    fn extracts_only_cookie_pairs_from_login_response() {
        let response = ApiResponse {
            status: 200,
            body: json!({
                "code": 803,
                "cookie": "MUSIC_U=secret-value;; __csrf=csrf-value; Path=/; HttpOnly"
            }),
            cookie: vec!["NMTID=device-value; Max-Age=31536000; Path=/".to_string()],
        };

        assert_eq!(
            authenticated_cookie(&response).expect("authenticated cookie"),
            "MUSIC_U=secret-value; NMTID=device-value; __csrf=csrf-value"
        );
    }

    #[test]
    fn refuses_a_response_without_an_account_session() {
        let response = ApiResponse {
            status: 200,
            body: json!({ "code": 803, "cookie": "__csrf=csrf-value" }),
            cookie: Vec::new(),
        };

        assert!(authenticated_cookie(&response).is_err());
    }

    #[test]
    fn maps_only_a_valid_profile_to_the_webview_contract() {
        let user = auth_user(&json!({
            "data": {
                "profile": {
                    "userId": 42,
                    "nickname": "listener",
                    "avatarUrl": "https://example.test/avatar.jpg",
                    "signature": "hello",
                    "vipType": 11
                }
            }
        }))
        .expect("profile");

        assert_eq!(user.user_id, 42);
        assert_eq!(user.nickname, "listener");
    }

    #[test]
    fn qr_status_serialization_does_not_include_credentials() {
        assert_eq!(
            serde_json::to_string(&QrLoginStatus::Authorized).expect("status"),
            "\"authorized\""
        );
    }

    #[tokio::test]
    #[ignore = "requires live access to the Netease API"]
    async fn live_qr_key_contract() {
        let response = create_client(None)
            .login_qr_key(&Query::new())
            .await
            .expect("live QR key response");

        assert!(
            qr_login_key(&response.body).is_some(),
            "unexpected QR key response: {}",
            response.body
        );
    }
}
