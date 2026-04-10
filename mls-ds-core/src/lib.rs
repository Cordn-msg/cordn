use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use bincode::{config, error::DecodeError, error::EncodeError};
use openmls::prelude::{GroupEpoch, GroupId, KeyPackageIn, KeyPackageRef, MlsMessageIn};
use rusqlite::{params, Connection, OptionalExtension};
use tls_codec::Deserialize as TlsDeserializeTrait;

#[cfg(test)]
mod test_support;

pub type StableIdentity = String;
pub type DeliveryAddress = String;
pub type Epoch = GroupEpoch;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct IdentityRecord {
    pub stable_identity: StableIdentity,
    pub delivery_addresses: Vec<DeliveryAddress>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct GroupRoute {
    pub group_id: GroupId,
    pub epoch: Epoch,
    pub members: Vec<DeliveryAddress>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WelcomeMessage {
    pub stable_identity: StableIdentity,
    pub key_package_ref: KeyPackageRef,
    pub message_bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct GroupMessage {
    pub group_id: GroupId,
    pub epoch: Epoch,
    pub sender: DeliveryAddress,
    pub recipients: Vec<DeliveryAddress>,
    pub message_bytes: Vec<u8>,
}

pub type KeyPackage = (KeyPackageRef, KeyPackageIn);

impl WelcomeMessage {
    pub fn message(&self) -> Result<MlsMessageIn, CoordinatorError> {
        let mut bytes = self.message_bytes.as_slice();
        MlsMessageIn::tls_deserialize(&mut bytes).map_err(CoordinatorError::TlsDeserialize)
    }
}

impl GroupMessage {
    pub fn message(&self) -> Result<MlsMessageIn, CoordinatorError> {
        let mut bytes = self.message_bytes.as_slice();
        MlsMessageIn::tls_deserialize(&mut bytes).map_err(CoordinatorError::TlsDeserialize)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CoordinatorError {
    #[error("group route not found")]
    UnknownGroup,
    #[error("identity not found")]
    UnknownIdentity,
    #[error("stale epoch: expected at least {expected}, got {received}")]
    StaleEpoch { expected: Epoch, received: Epoch },
    #[error("sender is not a member of the group route")]
    SenderNotMember,
    #[error("no key package available for identity")]
    NoKeyPackageAvailable,
    #[error("welcome key package reference does not match a reserved key package")]
    UnknownWelcomeKeyPackage,
    #[error("sqlite storage error: {0}")]
    Storage(#[source] rusqlite::Error),
    #[error("tls deserialize error: {0}")]
    TlsDeserialize(#[source] tls_codec::Error),
    #[error("binary encode error: {0}")]
    BinaryEncode(#[source] EncodeError),
    #[error("binary decode error: {0}")]
    BinaryDecode(#[source] DecodeError),
}

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
pub struct BlindCoordinator {
    identities: HashMap<StableIdentity, IdentityRecord>,
    key_packages: HashMap<StableIdentity, VecDeque<KeyPackage>>,
    reserved_welcome_refs: HashMap<StableIdentity, Vec<KeyPackageRef>>,
    group_routes: HashMap<GroupId, GroupRoute>,
    welcome_queues: HashMap<StableIdentity, VecDeque<WelcomeMessage>>,
    message_queues: HashMap<DeliveryAddress, VecDeque<GroupMessage>>,
}

impl BlindCoordinator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn upsert_identity(&mut self, identity: IdentityRecord) {
        self.identities
            .insert(identity.stable_identity.clone(), identity);
    }

    pub fn list_identities(&self) -> Vec<IdentityRecord> {
        self.identities.values().cloned().collect()
    }

    pub fn identity(&self, stable_identity: &str) -> Option<&IdentityRecord> {
        self.identities.get(stable_identity)
    }

    pub fn publish_key_packages(
        &mut self,
        stable_identity: &str,
        key_packages: impl IntoIterator<Item = KeyPackage>,
    ) -> Result<usize, CoordinatorError> {
        if !self.identities.contains_key(stable_identity) {
            return Err(CoordinatorError::UnknownIdentity);
        }

        let queue = self
            .key_packages
            .entry(stable_identity.to_owned())
            .or_default();
        let start_len = queue.len();
        queue.extend(key_packages);
        Ok(queue.len() - start_len)
    }

    pub fn list_key_packages(
        &self,
        stable_identity: &str,
    ) -> Result<Vec<KeyPackage>, CoordinatorError> {
        if !self.identities.contains_key(stable_identity) {
            return Err(CoordinatorError::UnknownIdentity);
        }

        Ok(self
            .key_packages
            .get(stable_identity)
            .map(|queue| queue.iter().cloned().collect())
            .unwrap_or_default())
    }

    pub fn consume_key_package(
        &mut self,
        stable_identity: &str,
    ) -> Result<KeyPackage, CoordinatorError> {
        if !self.identities.contains_key(stable_identity) {
            return Err(CoordinatorError::UnknownIdentity);
        }

        let key_package = self
            .key_packages
            .get_mut(stable_identity)
            .and_then(VecDeque::pop_front)
            .ok_or(CoordinatorError::NoKeyPackageAvailable)?;

        self.reserved_welcome_refs
            .entry(stable_identity.to_owned())
            .or_default()
            .push(key_package.0.clone());

        Ok(key_package)
    }

    pub fn put_group_route(&mut self, route: GroupRoute) {
        self.group_routes.insert(route.group_id.clone(), route);
    }

    pub fn group_route(&self, group_id: &GroupId) -> Option<&GroupRoute> {
        self.group_routes.get(group_id)
    }

    pub fn store_welcome(&mut self, welcome: WelcomeMessage) -> Result<(), CoordinatorError> {
        if !self.identities.contains_key(&welcome.stable_identity) {
            return Err(CoordinatorError::UnknownIdentity);
        }

        let reserved = self
            .reserved_welcome_refs
            .get_mut(&welcome.stable_identity)
            .ok_or(CoordinatorError::UnknownWelcomeKeyPackage)?;

        let Some(index) = reserved
            .iter()
            .position(|reference| reference == &welcome.key_package_ref)
        else {
            return Err(CoordinatorError::UnknownWelcomeKeyPackage);
        };

        reserved.swap_remove(index);
        self.welcome_queues
            .entry(welcome.stable_identity.clone())
            .or_default()
            .push_back(welcome);
        Ok(())
    }

    pub fn drain_welcomes(&mut self, stable_identity: &str) -> Vec<WelcomeMessage> {
        self.welcome_queues
            .remove(stable_identity)
            .map(|queue| queue.into_iter().collect())
            .unwrap_or_default()
    }

    pub fn post_group_message(&mut self, message: GroupMessage) -> Result<(), CoordinatorError> {
        let route = self
            .group_routes
            .get_mut(&message.group_id)
            .ok_or(CoordinatorError::UnknownGroup)?;

        if message.epoch < route.epoch {
            return Err(CoordinatorError::StaleEpoch {
                expected: route.epoch,
                received: message.epoch,
            });
        }

        if !route.members.iter().any(|member| member == &message.sender) {
            return Err(CoordinatorError::SenderNotMember);
        }

        route.epoch = message.epoch;

        for recipient in &route.members {
            if recipient == &message.sender {
                continue;
            }

            if !message.recipients.iter().any(|candidate| candidate == recipient) {
                continue;
            }

            self.message_queues
                .entry(recipient.clone())
                .or_default()
                .push_back(message.clone());
        }

        Ok(())
    }

    pub fn drain_group_messages(&mut self, delivery_address: &str) -> Vec<GroupMessage> {
        self.message_queues
            .remove(delivery_address)
            .map(|queue| queue.into_iter().collect())
            .unwrap_or_default()
    }
}

pub trait CoordinatorStore {
    fn load(&self) -> Result<Option<BlindCoordinator>, CoordinatorError>;
    fn save(&self, coordinator: &BlindCoordinator) -> Result<(), CoordinatorError>;
}

#[derive(Debug)]
pub struct SqliteCoordinatorStore {
    connection: Mutex<Connection>,
}

impl SqliteCoordinatorStore {
    pub fn open(path: &str) -> Result<Self, CoordinatorError> {
        let connection = Connection::open(path).map_err(CoordinatorError::Storage)?;
        let store = Self {
            connection: Mutex::new(connection),
        };
        store.initialize()?;
        Ok(store)
    }

    pub fn open_in_memory() -> Result<Self, CoordinatorError> {
        let connection = Connection::open_in_memory().map_err(CoordinatorError::Storage)?;
        let store = Self {
            connection: Mutex::new(connection),
        };
        store.initialize()?;
        Ok(store)
    }

    fn initialize(&self) -> Result<(), CoordinatorError> {
        let connection = self.connection.lock().expect("sqlite mutex poisoned");
        connection
            .execute_batch(
                "
                CREATE TABLE IF NOT EXISTS coordinator_state (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    snapshot BLOB NOT NULL
                );
                ",
            )
            .map_err(CoordinatorError::Storage)
    }
}

impl CoordinatorStore for SqliteCoordinatorStore {
    fn load(&self) -> Result<Option<BlindCoordinator>, CoordinatorError> {
        let connection = self.connection.lock().expect("sqlite mutex poisoned");
        let snapshot = connection
            .query_row(
                "SELECT snapshot FROM coordinator_state WHERE id = 1",
                [],
                |row| row.get::<_, Vec<u8>>(0),
            )
            .optional()
            .map_err(CoordinatorError::Storage)?;

        snapshot
            .map(|bytes| {
                bincode::serde::decode_from_slice(&bytes, config::standard())
                    .map(|(state, _)| state)
                    .map_err(CoordinatorError::BinaryDecode)
            })
            .transpose()
    }

    fn save(&self, coordinator: &BlindCoordinator) -> Result<(), CoordinatorError> {
        let snapshot = bincode::serde::encode_to_vec(coordinator, config::standard())
            .map_err(CoordinatorError::BinaryEncode)?;
        let connection = self.connection.lock().expect("sqlite mutex poisoned");
        connection
            .execute(
                "
                INSERT INTO coordinator_state (id, snapshot)
                VALUES (1, ?1)
                ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot
                ",
                params![snapshot],
            )
            .map_err(CoordinatorError::Storage)?;
        Ok(())
    }
}

#[derive(Debug)]
pub struct DeliveryService<S> {
    coordinator: BlindCoordinator,
    store: S,
}

impl<S: CoordinatorStore> DeliveryService<S> {
    pub fn open(store: S) -> Result<Self, CoordinatorError> {
        let coordinator = store.load()?.unwrap_or_default();
        Ok(Self { coordinator, store })
    }

    pub fn coordinator(&self) -> &BlindCoordinator {
        &self.coordinator
    }

    pub fn register_client(&mut self, identity: IdentityRecord) -> Result<(), CoordinatorError> {
        self.coordinator.upsert_identity(identity);
        self.persist()
    }

    pub fn list_clients(&self) -> Vec<IdentityRecord> {
        self.coordinator.list_identities()
    }

    pub fn publish_key_packages(
        &mut self,
        stable_identity: &str,
        key_packages: impl IntoIterator<Item = KeyPackage>,
    ) -> Result<usize, CoordinatorError> {
        let published = self
            .coordinator
            .publish_key_packages(stable_identity, key_packages)?;
        self.persist()?;
        Ok(published)
    }

    pub fn get_key_packages(
        &self,
        stable_identity: &str,
    ) -> Result<Vec<KeyPackage>, CoordinatorError> {
        self.coordinator.list_key_packages(stable_identity)
    }

    pub fn consume_key_package(
        &mut self,
        stable_identity: &str,
    ) -> Result<KeyPackage, CoordinatorError> {
        let key_package = self.coordinator.consume_key_package(stable_identity)?;
        self.persist()?;
        Ok(key_package)
    }

    pub fn put_group_route(&mut self, route: GroupRoute) -> Result<(), CoordinatorError> {
        self.coordinator.put_group_route(route);
        self.persist()
    }

    pub fn send_welcome(&mut self, welcome: WelcomeMessage) -> Result<(), CoordinatorError> {
        self.coordinator.store_welcome(welcome)?;
        self.persist()
    }

    pub fn recv_welcomes(
        &mut self,
        stable_identity: &str,
    ) -> Result<Vec<WelcomeMessage>, CoordinatorError> {
        let welcomes = self.coordinator.drain_welcomes(stable_identity);
        self.persist()?;
        Ok(welcomes)
    }

    pub fn send_message(&mut self, message: GroupMessage) -> Result<(), CoordinatorError> {
        self.coordinator.post_group_message(message)?;
        self.persist()
    }

    pub fn recv_messages(
        &mut self,
        delivery_address: &str,
    ) -> Result<Vec<GroupMessage>, CoordinatorError> {
        let messages = self.coordinator.drain_group_messages(delivery_address);
        self.persist()?;
        Ok(messages)
    }

    fn persist(&self) -> Result<(), CoordinatorError> {
        self.store.save(&self.coordinator)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CoordinatorError, DeliveryService, GroupMessage, GroupRoute, IdentityRecord,
        SqliteCoordinatorStore, WelcomeMessage,
    };
    use openmls::prelude::GroupId;

    use super::test_support::{mls_message_bytes, published_key_package};

    fn alice_identity() -> IdentityRecord {
        IdentityRecord {
            stable_identity: "npub1alice".into(),
            delivery_addresses: vec!["ephemeral-alice-1".into()],
        }
    }

    fn service() -> DeliveryService<SqliteCoordinatorStore> {
        DeliveryService::open(SqliteCoordinatorStore::open_in_memory().expect("sqlite store"))
            .expect("service")
    }

    #[test]
    fn registers_and_lists_clients() {
        let mut service = service();
        service.register_client(alice_identity()).expect("register");

        assert_eq!(service.list_clients().len(), 1);
        assert_eq!(
            service.coordinator().identity("npub1alice").expect("identity").stable_identity,
            "npub1alice"
        );
    }

    #[test]
    fn publishes_lists_and_consumes_key_packages() {
        let mut service = service();
        service.register_client(alice_identity()).expect("register");

        let kp1 = published_key_package(b"kp-1");
        let kp2 = published_key_package(b"kp-2");

        let published = service
            .publish_key_packages(
                "npub1alice",
                [kp1.clone(), kp2.clone()],
            )
            .expect("publish");

        assert_eq!(published, 2);
        assert_eq!(service.get_key_packages("npub1alice").expect("list").len(), 2);

        let consumed = service.consume_key_package("npub1alice").expect("consume");
        assert_eq!(consumed.0, kp1.0);
        assert_eq!(consumed.1, kp1.1);
        assert_eq!(service.get_key_packages("npub1alice").expect("list").len(), 1);
    }

    #[test]
    fn rejects_key_package_operations_for_unknown_identities() {
        let mut service = service();

        assert!(matches!(
            service
                .publish_key_packages(
                    "npub1missing",
                    [published_key_package(b"kp-1")],
                )
                .expect_err("unknown identity must fail"),
            CoordinatorError::UnknownIdentity
        ));
    }

    #[test]
    fn fails_when_no_key_packages_are_available() {
        let mut service = service();
        service.register_client(alice_identity()).expect("register");

        assert!(matches!(
            service
                .consume_key_package("npub1alice")
                .expect_err("empty queue must fail"),
            CoordinatorError::NoKeyPackageAvailable
        ));
    }

    #[test]
    fn stores_and_drains_welcome_queue() {
        let mut service = service();
        service.register_client(alice_identity()).expect("register");
        service
            .publish_key_packages(
                "npub1alice",
                [published_key_package(b"kp-1")],
            )
            .expect("publish");

        let consumed = service.consume_key_package("npub1alice").expect("consume");
        service
                .send_welcome(WelcomeMessage {
                    stable_identity: "npub1alice".into(),
                    key_package_ref: consumed.0,
                    message_bytes: mls_message_bytes(b"welcome-for-alice"),
                })
            .expect("welcome");

        assert_eq!(service.recv_welcomes("npub1alice").expect("recv").len(), 1);
        assert!(service.recv_welcomes("npub1alice").expect("recv").is_empty());
    }

    #[test]
    fn rejects_welcome_for_unreserved_key_package() {
        let mut service = service();
        service.register_client(alice_identity()).expect("register");

        assert!(matches!(
            service
                .send_welcome(WelcomeMessage {
                    stable_identity: "npub1alice".into(),
                    key_package_ref: published_key_package(b"kp-missing").0,
                    message_bytes: mls_message_bytes(b"welcome-missing"),
                })
                .expect_err("unreserved welcome should fail"),
            CoordinatorError::UnknownWelcomeKeyPackage
        ));
    }

    #[test]
    fn rejects_stale_epochs() {
        let mut service = service();
        service
            .put_group_route(GroupRoute {
                group_id: GroupId::from_slice(b"group-a"),
                epoch: 3.into(),
                members: vec!["ephemeral-alice-1".into(), "ephemeral-bob-1".into()],
            })
            .expect("route");

        let error = service
            .send_message(GroupMessage {
                group_id: GroupId::from_slice(b"group-a"),
                epoch: 2.into(),
                sender: "ephemeral-alice-1".into(),
                recipients: vec!["ephemeral-bob-1".into()],
                message_bytes: mls_message_bytes(b"stale-epoch"),
            })
            .expect_err("stale epoch must fail");

        match error {
            CoordinatorError::StaleEpoch { expected, received } => {
                assert_eq!(expected, 3.into());
                assert_eq!(received, 2.into());
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[test]
    fn routes_only_to_declared_recipients() {
        let mut service = service();
        service
            .put_group_route(GroupRoute {
                group_id: GroupId::from_slice(b"group-a"),
                epoch: 0.into(),
                members: vec![
                    "ephemeral-alice-1".into(),
                    "ephemeral-bob-1".into(),
                    "ephemeral-carol-1".into(),
                ],
            })
            .expect("route");

        service
            .send_message(GroupMessage {
                group_id: GroupId::from_slice(b"group-a"),
                epoch: 1.into(),
                sender: "ephemeral-alice-1".into(),
                recipients: vec!["ephemeral-bob-1".into()],
                message_bytes: mls_message_bytes(b"route-bob-only"),
            })
            .expect("message");

        assert_eq!(service.recv_messages("ephemeral-bob-1").expect("recv").len(), 1);
        assert!(service
            .recv_messages("ephemeral-carol-1")
            .expect("recv")
            .is_empty());
    }

    #[test]
    fn persists_state_in_sqlite() {
        let store = SqliteCoordinatorStore::open_in_memory().expect("sqlite store");
        let mut service = DeliveryService::open(store).expect("service");
        service.register_client(alice_identity()).expect("register");
        service
            .publish_key_packages(
                "npub1alice",
                [published_key_package(b"kp-1")],
            )
            .expect("publish");

        let store = service.store;
        let service = DeliveryService::open(store).expect("reopen service");
        assert_eq!(service.list_clients().len(), 1);
        assert_eq!(service.get_key_packages("npub1alice").expect("list").len(), 1);
    }
}
