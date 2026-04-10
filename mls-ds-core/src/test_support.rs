use openmls::prelude::{
    BasicCredential, Ciphersuite, CredentialWithKey, Extensions, KeyPackage as OpenMlsKeyPackage,
    KeyPackageBundle, KeyPackageIn, KeyPackageRef, MlsMessageOut,
};
use openmls_basic_credential::SignatureKeyPair;
use openmls_rust_crypto::OpenMlsRustCrypto;
use openmls_traits::{types::SignatureScheme, OpenMlsProvider};
use tls_codec::Serialize as _;

fn generate_credential(
    identity: &[u8],
    signature_scheme: SignatureScheme,
) -> (CredentialWithKey, SignatureKeyPair) {
    let credential = BasicCredential::new(identity.to_vec());
    let signature_keys = SignatureKeyPair::new(signature_scheme).expect("signature keys");
    let credential_with_key = CredentialWithKey {
        credential: credential.into(),
        signature_key: signature_keys.to_public_vec().into(),
    };

    (credential_with_key, signature_keys)
}

fn generate_key_package_bundle(identity: &[u8]) -> (OpenMlsRustCrypto, KeyPackageBundle) {
    let provider = OpenMlsRustCrypto::default();
    let ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
    let (credential_with_key, signer) =
        generate_credential(identity, SignatureScheme::from(ciphersuite));
    let bundle = OpenMlsKeyPackage::builder()
        .key_package_extensions(Extensions::empty())
        .build(ciphersuite, &provider, &signer, credential_with_key)
        .expect("key package bundle");

    (provider, bundle)
}

pub fn published_key_package(identity: &[u8]) -> (KeyPackageRef, KeyPackageIn) {
    let (provider, bundle) = generate_key_package_bundle(identity);
    (
        bundle
            .key_package()
            .hash_ref(provider.crypto())
            .expect("hash ref"),
        KeyPackageIn::from(bundle.key_package().clone()),
    )
}

pub fn mls_message_bytes(identity: &[u8]) -> Vec<u8> {
    let (_, bundle) = generate_key_package_bundle(identity);
    MlsMessageOut::from(bundle.key_package().clone())
        .tls_serialize_detached()
        .expect("serialize mls message")
}
