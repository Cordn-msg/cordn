use mls_ds_core::{
    DeliveryService, GroupMessage, GroupRoute, IdentityRecord, SqliteCoordinatorStore,
    WelcomeMessage,
};
use openmls::prelude::GroupId;
use std::{env, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};

#[path = "../src/test_support.rs"]
mod test_support;

use test_support::{mls_message_bytes, published_key_package};

fn alice_identity() -> IdentityRecord {
    IdentityRecord {
        stable_identity: "npub1alice".into(),
        delivery_addresses: vec!["ephemeral-alice-1".into()],
    }
}

fn bob_identity() -> IdentityRecord {
    IdentityRecord {
        stable_identity: "npub1bob".into(),
        delivery_addresses: vec!["ephemeral-bob-1".into()],
    }
}

fn carol_identity() -> IdentityRecord {
    IdentityRecord {
        stable_identity: "npub1carol".into(),
        delivery_addresses: vec!["ephemeral-carol-1".into()],
    }
}

fn service() -> DeliveryService<SqliteCoordinatorStore> {
    DeliveryService::open(SqliteCoordinatorStore::open_in_memory().expect("sqlite store"))
        .expect("service")
}

fn sqlite_test_path(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time before epoch")
        .as_nanos();
    env::temp_dir().join(format!("mls-ds-core-{name}-{nanos}.sqlite"))
}

#[test]
fn invitation_flow_delivers_only_reserved_welcome_and_targeted_messages() {
    let mut service = service();
    service.register_client(alice_identity()).expect("register alice");
    service.register_client(bob_identity()).expect("register bob");
    service.register_client(carol_identity()).expect("register carol");

    service
        .publish_key_packages(
            "npub1bob",
            [published_key_package(b"bob-kp-1")],
        )
        .expect("publish bob key package");

    let consumed = service
        .consume_key_package("npub1bob")
        .expect("consume bob key package");

    service
        .send_welcome(WelcomeMessage {
            stable_identity: "npub1bob".into(),
            key_package_ref: consumed.0,
            message_bytes: mls_message_bytes(b"welcome-bob"),
        })
        .expect("send welcome");

    let welcomes = service.recv_welcomes("npub1bob").expect("recv welcomes");
    assert_eq!(welcomes.len(), 1);
    assert_eq!(welcomes[0].stable_identity, "npub1bob");
    assert!(service
        .recv_welcomes("npub1carol")
        .expect("recv welcomes")
        .is_empty());

    service
        .put_group_route(GroupRoute {
            group_id: GroupId::from_slice(b"group-1"),
            epoch: 0.into(),
            members: vec![
                "ephemeral-alice-1".into(),
                "ephemeral-bob-1".into(),
                "ephemeral-carol-1".into(),
            ],
        })
        .expect("put route");

    service
        .send_message(GroupMessage {
            group_id: GroupId::from_slice(b"group-1"),
            epoch: 1.into(),
            sender: "ephemeral-alice-1".into(),
            recipients: vec!["ephemeral-bob-1".into(), "ephemeral-carol-1".into()],
            message_bytes: mls_message_bytes(b"group-1-msg-1"),
        })
        .expect("send message");

    assert_eq!(
        service
            .recv_messages("ephemeral-bob-1")
            .expect("recv bob messages")
            .len(),
        1
    );
    assert_eq!(
        service
            .recv_messages("ephemeral-carol-1")
            .expect("recv carol messages")
            .len(),
        1
    );
    assert!(service
        .recv_messages("ephemeral-alice-1")
        .expect("recv alice messages")
        .is_empty());
}

#[test]
fn persistence_survives_reopen_across_multi_step_flow() {
    let path = sqlite_test_path("persistence-flow");
    let mut service =
        DeliveryService::open(SqliteCoordinatorStore::open(path.to_str().expect("utf-8 path"))
            .expect("sqlite store"))
            .expect("service");

    service.register_client(alice_identity()).expect("register alice");
    service.register_client(bob_identity()).expect("register bob");
    service = DeliveryService::open(
        SqliteCoordinatorStore::open(path.to_str().expect("utf-8 path")).expect("sqlite store"),
    )
    .expect("reopen after register");

    service
        .publish_key_packages(
            "npub1bob",
            [published_key_package(b"bob-kp-1")],
        )
        .expect("publish bob key package");
    service = DeliveryService::open(
        SqliteCoordinatorStore::open(path.to_str().expect("utf-8 path")).expect("sqlite store"),
    )
    .expect("reopen after publish");

    let consumed = service
        .consume_key_package("npub1bob")
        .expect("consume bob key package");
    service = DeliveryService::open(
        SqliteCoordinatorStore::open(path.to_str().expect("utf-8 path")).expect("sqlite store"),
    )
    .expect("reopen after consume");

    service
        .send_welcome(WelcomeMessage {
            stable_identity: "npub1bob".into(),
            key_package_ref: consumed.0,
            message_bytes: mls_message_bytes(b"welcome-bob-persist"),
        })
        .expect("send welcome");
    service = DeliveryService::open(
        SqliteCoordinatorStore::open(path.to_str().expect("utf-8 path")).expect("sqlite store"),
    )
    .expect("reopen after welcome");

    assert_eq!(service.list_clients().len(), 2);
    assert_eq!(service.recv_welcomes("npub1bob").expect("recv welcomes").len(), 1);
    assert!(service.get_key_packages("npub1bob").expect("list key packages").is_empty());

    let _ = std::fs::remove_file(path);
}

#[test]
fn route_updates_support_delivery_address_rotation() {
    let mut service = service();
    service.register_client(alice_identity()).expect("register alice");
    service.register_client(bob_identity()).expect("register bob");

    service
        .put_group_route(GroupRoute {
            group_id: GroupId::from_slice(b"group-rotate"),
            epoch: 0.into(),
            members: vec!["ephemeral-alice-1".into(), "ephemeral-bob-1".into()],
        })
        .expect("put initial route");

    service
        .send_message(GroupMessage {
            group_id: GroupId::from_slice(b"group-rotate"),
            epoch: 1.into(),
            sender: "ephemeral-alice-1".into(),
            recipients: vec!["ephemeral-bob-1".into()],
            message_bytes: mls_message_bytes(b"rotate-1"),
        })
        .expect("send first message");

    assert_eq!(
        service
            .recv_messages("ephemeral-bob-1")
            .expect("recv old bob address")
            .len(),
        1
    );

    service
        .put_group_route(GroupRoute {
            group_id: GroupId::from_slice(b"group-rotate"),
            epoch: 1.into(),
            members: vec!["ephemeral-alice-1".into(), "ephemeral-bob-2".into()],
        })
        .expect("rotate route");

    service
        .send_message(GroupMessage {
            group_id: GroupId::from_slice(b"group-rotate"),
            epoch: 2.into(),
            sender: "ephemeral-alice-1".into(),
            recipients: vec!["ephemeral-bob-2".into()],
            message_bytes: mls_message_bytes(b"rotate-2"),
        })
        .expect("send rotated message");

    assert_eq!(
        service
            .recv_messages("ephemeral-bob-2")
            .expect("recv new bob address")
            .len(),
        1
    );
    assert!(service
        .recv_messages("ephemeral-bob-1")
        .expect("recv drained old bob address")
        .is_empty());
}

#[test]
fn old_recipients_stop_receiving_after_route_change() {
    let mut service = service();

    service
        .put_group_route(GroupRoute {
            group_id: GroupId::from_slice(b"group-1"),
            epoch: 0.into(),
            members: vec!["ephemeral-alice-1".into(), "ephemeral-bob-1".into()],
        })
        .expect("put route");

    service
        .put_group_route(GroupRoute {
            group_id: GroupId::from_slice(b"group-1"),
            epoch: 1.into(),
            members: vec!["ephemeral-alice-1".into(), "ephemeral-bob-2".into()],
        })
        .expect("update route");

    service
        .send_message(GroupMessage {
            group_id: GroupId::from_slice(b"group-1"),
            epoch: 2.into(),
            sender: "ephemeral-alice-1".into(),
            recipients: vec!["ephemeral-bob-1".into()],
            message_bytes: mls_message_bytes(b"route-changed"),
        })
        .expect("message with stale recipient list is ignored for removed members");

    assert!(service
        .recv_messages("ephemeral-bob-1")
        .expect("recv old bob address")
        .is_empty());
    assert!(service
        .recv_messages("ephemeral-bob-2")
        .expect("recv new bob address")
        .is_empty());
}
