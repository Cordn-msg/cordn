use std::env;
use std::io::{self, BufRead, Write};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use mls_ds_core::{
    CoordinatorError, DeliveryService, GroupMessage, GroupRoute, IdentityRecord, KeyPackage,
    SqliteCoordinatorStore, WelcomeMessage,
};
use openmls::prelude::{GroupEpoch, GroupId, KeyPackageIn, KeyPackageRef};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use tls_codec::{Deserialize as TlsDeserializeTrait, Serialize as TlsSerializeTrait};

type Service = DeliveryService<SqliteCoordinatorStore>;

#[derive(Debug, Deserialize)]
struct RequestEnvelope {
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct SuccessResponse<T> {
    id: String,
    ok: bool,
    result: T,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    id: String,
    ok: bool,
    error: ErrorBody,
}

#[derive(Debug, Serialize)]
struct BridgeInfo<'a> {
    status: &'a str,
    contract: &'a str,
    bridge: &'a str,
    database_path: String,
}

#[derive(Debug, Deserialize)]
struct RegisterClientParams {
    stable_identity: String,
    delivery_addresses: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct StableIdentityParams {
    stable_identity: String,
}

#[derive(Debug, Deserialize)]
struct PutGroupRouteParams {
    group_id: String,
    epoch: u64,
    members: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct SendWelcomeParams {
    stable_identity: String,
    key_package_ref: String,
    message_bytes: String,
}

#[derive(Debug, Deserialize)]
struct SendMessageParams {
    group_id: String,
    epoch: u64,
    sender: String,
    recipients: Vec<String>,
    message_bytes: String,
}

#[derive(Debug, Deserialize)]
struct RecvMessagesParams {
    delivery_address: String,
}

#[derive(Debug, Deserialize)]
struct PublishKeyPackagesParams {
    stable_identity: String,
    key_packages: Vec<KeyPackageDto>,
}

#[derive(Debug, Serialize, Deserialize)]
struct KeyPackageDto {
    key_package_ref: String,
    key_package: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct IdentityRecordDto {
    stable_identity: String,
    delivery_addresses: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct WelcomeMessageDto {
    stable_identity: String,
    key_package_ref: String,
    message_bytes: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct GroupMessageDto {
    group_id: String,
    epoch: u64,
    sender: String,
    recipients: Vec<String>,
    message_bytes: String,
}

#[derive(Debug, Serialize)]
struct RegisteredResult {
    registered: bool,
}

#[derive(Debug, Serialize)]
struct StoredResult {
    stored: bool,
}

#[derive(Debug, Serialize)]
struct ClientsResult {
    clients: Vec<IdentityRecordDto>,
}

#[derive(Debug, Serialize)]
struct PublishedResult {
    published: usize,
}

#[derive(Debug, Serialize)]
struct KeyPackagesResult {
    key_packages: Vec<KeyPackageDto>,
}

#[derive(Debug, Serialize)]
struct KeyPackageResult {
    key_package: KeyPackageDto,
}

#[derive(Debug, Serialize)]
struct WelcomesResult {
    welcomes: Vec<WelcomeMessageDto>,
}

#[derive(Debug, Serialize)]
struct MessagesResult {
    messages: Vec<GroupMessageDto>,
}

fn main() {
    if let Err(error) = run() {
        let _ = writeln!(io::stderr(), "mls-ds-server error: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let database_path = env::var("MLS_DS_DB_PATH").unwrap_or_else(|_| ":memory:".into());
    let store = if database_path == ":memory:" {
        SqliteCoordinatorStore::open_in_memory()?
    } else {
        SqliteCoordinatorStore::open(&database_path)?
    };
    let mut service = DeliveryService::open(store)?;

    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();

    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }

        let response = process_line(&mut service, &database_path, &line)?;
        writeln!(stdout, "{response}")?;
        stdout.flush()?;
    }

    Ok(())
}

fn process_line(
    service: &mut Service,
    database_path: &str,
    line: &str,
) -> Result<String, serde_json::Error> {
    let request = match serde_json::from_str::<RequestEnvelope>(line) {
        Ok(request) => request,
        Err(error) => {
            return serde_json::to_string(&ErrorResponse {
                id: "unknown".into(),
                ok: false,
                error: ErrorBody {
                    code: "invalid_request",
                    message: format!("invalid request JSON: {error}"),
                    details: None,
                },
            })
        }
    };

    Ok(handle_request(service, database_path, request))
}

fn handle_request(service: &mut Service, database_path: &str, request: RequestEnvelope) -> String {
    let RequestEnvelope { id, method, params } = request;
    let request = RequestEnvelope {
        id: id.clone(),
        method: method.clone(),
        params,
    };

    let response: Result<String, BridgeError> = match method.as_str() {
        "bridge_info" => {
            Ok::<String, BridgeError>(success(
                id.clone(),
                BridgeInfo {
                    status: "ready",
                    contract: "plans/mls-ds-api-contract.md",
                    bridge: "stdin-stdout-json",
                    database_path: database_path.to_owned(),
                },
            ))
        }
        "register_client" => parse_params::<RegisterClientParams>(&request).and_then(|params| {
            service
                .register_client(IdentityRecord {
                    stable_identity: params.stable_identity,
                    delivery_addresses: params.delivery_addresses,
                })
                .map(|_| RegisteredResult { registered: true })
                .map_err(BridgeError::from)
                .map(|result| success(id.clone(), result))
        }),
        "list_clients" => {
            Ok::<String, BridgeError>(success(
                id.clone(),
                ClientsResult {
                    clients: service
                        .list_clients()
                        .into_iter()
                        .map(identity_to_dto)
                        .collect(),
                },
            ))
        }
        "publish_key_packages" => parse_params::<PublishKeyPackagesParams>(&request).and_then(
            |params| {
                params
                    .key_packages
                    .into_iter()
                    .map(dto_to_key_package)
                    .collect::<Result<Vec<_>, _>>()
                    .and_then(|key_packages| {
                        service
                            .publish_key_packages(&params.stable_identity, key_packages)
                            .map_err(BridgeError::from)
                    })
                    .map(|published| success(id.clone(), PublishedResult { published }))
            },
        ),
        "get_key_packages" => parse_params::<StableIdentityParams>(&request).and_then(|params| {
            service
                .get_key_packages(&params.stable_identity)
                .map_err(BridgeError::from)
                .and_then(|key_packages| {
                    key_packages
                        .into_iter()
                        .map(key_package_to_dto)
                        .collect::<Result<Vec<_>, _>>()
                        .map(|key_packages| success(id.clone(), KeyPackagesResult { key_packages }))
                })
        }),
        "consume_key_package" => parse_params::<StableIdentityParams>(&request).and_then(
            |params| {
                service
                    .consume_key_package(&params.stable_identity)
                    .map_err(BridgeError::from)
                    .and_then(|key_package| {
                        key_package_to_dto(key_package)
                            .map(|key_package| success(id.clone(), KeyPackageResult { key_package }))
                    })
            },
        ),
        "put_group_route" => parse_params::<PutGroupRouteParams>(&request).and_then(|params| {
            service
                .put_group_route(GroupRoute {
                    group_id: decode_group_id(&params.group_id)?,
                    epoch: GroupEpoch::from(params.epoch),
                    members: params.members,
                })
                .map(|_| success(id.clone(), StoredResult { stored: true }))
                .map_err(BridgeError::from)
        }),
        "send_welcome" => parse_params::<SendWelcomeParams>(&request).and_then(|params| {
            service
                .send_welcome(WelcomeMessage {
                    stable_identity: params.stable_identity,
                    key_package_ref: decode_key_package_ref(&params.key_package_ref)?,
                    message_bytes: decode_base64url(&params.message_bytes, "message_bytes")?,
                })
                .map(|_| success(id.clone(), StoredResult { stored: true }))
                .map_err(BridgeError::from)
        }),
        "recv_welcomes" => parse_params::<StableIdentityParams>(&request).and_then(|params| {
            service
                .recv_welcomes(&params.stable_identity)
                .map_err(BridgeError::from)
                .and_then(|welcomes| {
                    welcomes
                        .into_iter()
                        .map(welcome_to_dto)
                        .collect::<Result<Vec<_>, _>>()
                        .map(|welcomes| success(id.clone(), WelcomesResult { welcomes }))
                })
        }),
        "send_message" => parse_params::<SendMessageParams>(&request).and_then(|params| {
            service
                .send_message(GroupMessage {
                    group_id: decode_group_id(&params.group_id)?,
                    epoch: GroupEpoch::from(params.epoch),
                    sender: params.sender,
                    recipients: params.recipients,
                    message_bytes: decode_base64url(&params.message_bytes, "message_bytes")?,
                })
                .map(|_| success(id.clone(), StoredResult { stored: true }))
                .map_err(BridgeError::from)
        }),
        "recv_messages" => parse_params::<RecvMessagesParams>(&request).and_then(|params| {
            service
                .recv_messages(&params.delivery_address)
                .map_err(BridgeError::from)
                .and_then(|messages| {
                    messages
                        .into_iter()
                        .map(message_to_dto)
                        .collect::<Result<Vec<_>, _>>()
                        .map(|messages| success(id.clone(), MessagesResult { messages }))
                })
        }),
        method => Err(BridgeError::unsupported_method(method)),
    };

    match response {
        Ok(response) => response,
        Err(error) => serialize_error(id, error),
    }
}

fn parse_params<T: DeserializeOwned>(request: &RequestEnvelope) -> Result<T, BridgeError> {
    serde_json::from_value(request.params.clone()).map_err(|error| BridgeError {
        code: "invalid_params",
        message: format!("invalid params: {error}"),
        details: None,
    })
}

fn success<T: Serialize>(id: String, result: T) -> String {
    serde_json::to_string(&SuccessResponse {
        id,
        ok: true,
        result,
    })
    .expect("serialize success response")
}

fn serialize_error(id: String, error: BridgeError) -> String {
    serde_json::to_string(&ErrorResponse {
        id,
        ok: false,
        error: ErrorBody {
            code: error.code,
            message: error.message,
            details: error.details,
        },
    })
    .expect("serialize error response")
}

#[derive(Debug)]
struct BridgeError {
    code: &'static str,
    message: String,
    details: Option<Value>,
}

impl BridgeError {
    fn unsupported_method(method: &str) -> Self {
        Self {
            code: "unsupported_method",
            message: format!(
                "method `{method}` is not implemented by the Rust bridge contract"
            ),
            details: None,
        }
    }

    fn invalid_base64(field: &'static str, error: impl std::fmt::Display) -> Self {
        Self {
            code: "invalid_params",
            message: format!("invalid base64url for `{field}`: {error}"),
            details: None,
        }
    }

    fn invalid_tls(field: &'static str, error: impl std::fmt::Display) -> Self {
        Self {
            code: "invalid_params",
            message: format!("invalid TLS bytes for `{field}`: {error}"),
            details: None,
        }
    }
}

impl From<CoordinatorError> for BridgeError {
    fn from(value: CoordinatorError) -> Self {
        match value {
            CoordinatorError::UnknownGroup => Self {
                code: "unknown_group",
                message: value.to_string(),
                details: None,
            },
            CoordinatorError::UnknownIdentity => Self {
                code: "unknown_identity",
                message: value.to_string(),
                details: None,
            },
            CoordinatorError::StaleEpoch { expected, received } => Self {
                code: "stale_epoch",
                message: format!("stale epoch: expected at least {expected}, got {received}"),
                details: Some(serde_json::json!({
                    "expected": expected.as_u64(),
                    "received": received.as_u64(),
                })),
            },
            CoordinatorError::SenderNotMember => Self {
                code: "sender_not_member",
                message: value.to_string(),
                details: None,
            },
            CoordinatorError::NoKeyPackageAvailable => Self {
                code: "no_key_package_available",
                message: value.to_string(),
                details: None,
            },
            CoordinatorError::UnknownWelcomeKeyPackage => Self {
                code: "unknown_welcome_key_package",
                message: value.to_string(),
                details: None,
            },
            CoordinatorError::TlsDeserialize(_) => Self {
                code: "invalid_mls_bytes",
                message: value.to_string(),
                details: None,
            },
            CoordinatorError::Storage(_) => Self {
                code: "storage_error",
                message: value.to_string(),
                details: None,
            },
            CoordinatorError::BinaryEncode(_) => Self {
                code: "internal_encoding_error",
                message: value.to_string(),
                details: None,
            },
            CoordinatorError::BinaryDecode(_) => Self {
                code: "internal_decoding_error",
                message: value.to_string(),
                details: None,
            },
        }
    }
}

fn decode_base64url(input: &str, field: &'static str) -> Result<Vec<u8>, BridgeError> {
    URL_SAFE_NO_PAD
        .decode(input)
        .map_err(|error| BridgeError::invalid_base64(field, error))
}

fn encode_base64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn decode_group_id(value: &str) -> Result<GroupId, BridgeError> {
    decode_base64url(value, "group_id").map(|bytes| GroupId::from_slice(&bytes))
}

fn decode_key_package_ref(value: &str) -> Result<KeyPackageRef, BridgeError> {
    let bytes = decode_base64url(value, "key_package_ref")?;
    let mut slice = bytes.as_slice();
    KeyPackageRef::tls_deserialize(&mut slice)
        .map_err(|error| BridgeError::invalid_tls("key_package_ref", error))
}

fn decode_key_package(value: &str) -> Result<KeyPackageIn, BridgeError> {
    let bytes = decode_base64url(value, "key_package")?;
    let mut slice = bytes.as_slice();
    KeyPackageIn::tls_deserialize(&mut slice).map_err(|error| BridgeError::invalid_tls("key_package", error))
}

fn key_package_to_dto((key_package_ref, key_package): KeyPackage) -> Result<KeyPackageDto, BridgeError> {
    Ok(KeyPackageDto {
        key_package_ref: encode_base64url(key_package_ref.as_slice()),
        key_package: encode_base64url(
            &key_package
                .tls_serialize_detached()
                .map_err(|error| BridgeError::invalid_tls("key_package", error))?,
        ),
    })
}

fn dto_to_key_package(dto: KeyPackageDto) -> Result<KeyPackage, BridgeError> {
    Ok((
        decode_key_package_ref(&dto.key_package_ref)?,
        decode_key_package(&dto.key_package)?,
    ))
}

fn identity_to_dto(identity: IdentityRecord) -> IdentityRecordDto {
    IdentityRecordDto {
        stable_identity: identity.stable_identity,
        delivery_addresses: identity.delivery_addresses,
    }
}

fn welcome_to_dto(welcome: WelcomeMessage) -> Result<WelcomeMessageDto, BridgeError> {
    Ok(WelcomeMessageDto {
        stable_identity: welcome.stable_identity,
        key_package_ref: encode_base64url(welcome.key_package_ref.as_slice()),
        message_bytes: encode_base64url(&welcome.message_bytes),
    })
}

fn message_to_dto(message: GroupMessage) -> Result<GroupMessageDto, BridgeError> {
    Ok(GroupMessageDto {
        group_id: encode_base64url(message.group_id.as_slice()),
        epoch: message.epoch.as_u64(),
        sender: message.sender,
        recipients: message.recipients,
        message_bytes: encode_base64url(&message.message_bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service() -> Service {
        DeliveryService::open(SqliteCoordinatorStore::open_in_memory().expect("sqlite"))
            .expect("service")
    }

    #[test]
    fn bridge_info_reports_contract() {
        let mut service = service();
        let response = process_line(
            &mut service,
            ":memory:",
            r#"{"id":"1","method":"bridge_info","params":{}}"#,
        )
        .expect("response");

        assert!(response.contains(r#""ok":true"#));
        assert!(response.contains(r#""contract":"plans/mls-ds-api-contract.md""#));
    }

    #[test]
    fn maps_unknown_identity_error() {
        let mut service = service();
        let response = process_line(
            &mut service,
            ":memory:",
            r#"{"id":"2","method":"consume_key_package","params":{"stable_identity":"npub1missing"}}"#,
        )
        .expect("response");

        assert!(response.contains(r#""code":"unknown_identity""#));
    }

    #[test]
    fn register_and_list_clients_round_trip() {
        let mut service = service();
        process_line(
            &mut service,
            ":memory:",
            r#"{"id":"1","method":"register_client","params":{"stable_identity":"npub1alice","delivery_addresses":["ephemeral-alice-1"]}}"#,
        )
        .expect("register response");

        let response = process_line(
            &mut service,
            ":memory:",
            r#"{"id":"2","method":"list_clients","params":{}}"#,
        )
        .expect("list response");

        assert!(response.contains("npub1alice"));
        assert!(response.contains("ephemeral-alice-1"));
    }
}
