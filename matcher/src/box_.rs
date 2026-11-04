//! Sealed boxes, identical to packages/sdk/src/box.ts:
//! eph X25519 ‖ nonce (24) ‖ XChaCha20-Poly1305(HKDF-SHA256(shared, eph ‖ recipient, "hushd.box.v1")).

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use sha2::Sha256;
use x25519_dalek::{PublicKey, StaticSecret};

fn key(shared: &[u8; 32], eph: &[u8; 32], recipient: &[u8; 32]) -> [u8; 32] {
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(eph);
    salt[32..].copy_from_slice(recipient);
    let mut out = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&salt), shared).expand(b"hushd.box.v1", &mut out).expect("hkdf length");
    out
}

pub fn open(secret: &StaticSecret, sealed: &[u8]) -> Option<Vec<u8>> {
    if sealed.len() < 32 + 24 + 16 {
        return None;
    }
    let eph: [u8; 32] = sealed[..32].try_into().ok()?;
    let nonce = XNonce::from_slice(&sealed[32..56]);
    let recipient = PublicKey::from(secret);
    let shared = secret.diffie_hellman(&PublicKey::from(eph));
    let k = key(shared.as_bytes(), &eph, recipient.as_bytes());
    XChaCha20Poly1305::new((&k).into()).decrypt(nonce, &sealed[56..]).ok()
}

pub fn seal(recipient: &[u8; 32], plaintext: &[u8]) -> Vec<u8> {
    let mut eph_seed = [0u8; 32];
    getrandom::getrandom(&mut eph_seed).expect("randomness");
    let eph = StaticSecret::from(eph_seed);
    let eph_pub = PublicKey::from(&eph);
    let shared = eph.diffie_hellman(&PublicKey::from(*recipient));
    let k = key(shared.as_bytes(), eph_pub.as_bytes(), recipient);
    let mut nonce = [0u8; 24];
    getrandom::getrandom(&mut nonce).expect("randomness");
    let ct = XChaCha20Poly1305::new((&k).into()).encrypt(XNonce::from_slice(&nonce), plaintext).expect("encrypt");
    [eph_pub.as_bytes().as_slice(), &nonce, &ct].concat()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_wrong_key() {
        let a = StaticSecret::from([1u8; 32]);
        let b = StaticSecret::from([2u8; 32]);
        let boxed = seal(PublicKey::from(&a).as_bytes(), b"terms");
        assert_eq!(open(&a, &boxed).unwrap(), b"terms");
        assert!(open(&b, &boxed).is_none());
    }
}
