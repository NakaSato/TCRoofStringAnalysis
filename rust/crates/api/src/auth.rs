//! Password hashes and JWTs, byte-compatible with backend/app/auth.py: a hash or a token made by
//! either backend is accepted by the other, so users keep their passwords and sessions at cutover.

use chrono::Utc;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use tcroof_db::User;

/// Python `secrets.token_hex(n)`: `n` random bytes as lowercase hex.
pub fn token_hex(n: usize) -> String {
    let mut buf = vec![0u8; n];
    getrandom::getrandom(&mut buf).expect("the OS random source");
    hex::encode(buf)
}

/// Python `hash_password`: PBKDF2-HMAC-SHA256, 120 000 iterations, a `token_hex(16)` salt whose
/// text (not its bytes) is the salt. CPU-heavy: call it from `spawn_blocking`.
pub fn hash_password(password: &str) -> String {
    let salt = token_hex(16);
    let mut dk = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), salt.as_bytes(), 120_000, &mut dk);
    format!("pbkdf2_sha256$120000${salt}${}", hex::encode(dk))
}

/// `pbkdf2_sha256$<iterations>$<salt>$<hex>`: the salt string's UTF-8 bytes are the salt (Python
/// passes `salt.encode()`), and the derived key is 32 bytes, compared as lowercase hex.
pub fn verify_password(plain: &str, stored: &str) -> bool {
    let mut parts = stored.splitn(4, '$');
    let (Some(algo), Some(iters), Some(salt), Some(want_hex)) = (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    if algo != "pbkdf2_sha256" {
        return false;
    }
    let Ok(iters) = iters.parse::<u32>() else { return false };
    if iters == 0 {
        return false;
    }
    let mut dk = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(plain.as_bytes(), salt.as_bytes(), iters, &mut dk);
    let got_hex = hex::encode(dk);
    got_hex.as_bytes().ct_eq(want_hex.as_bytes()).into()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub email: String,
    pub role: String,
    pub full_name: String,
    pub exp: i64,
}

pub fn create_access_token(user: &User, secret: &str, expire_minutes: i64) -> Result<String, jsonwebtoken::errors::Error> {
    let claims = Claims {
        sub: user.id.to_string(),
        email: user.email.clone(),
        role: user.role.clone(),
        full_name: user.full_name.clone(),
        exp: Utc::now().timestamp() + expire_minutes * 60,
    };
    encode(&Header::new(Algorithm::HS256), &claims, &EncodingKey::from_secret(secret.as_bytes()))
}

/// PyJWT checks `exp` with no leeway; so does this.
pub fn decode_access_token(token: &str, secret: &str) -> Result<Claims, jsonwebtoken::errors::Error> {
    let mut v = Validation::new(Algorithm::HS256);
    v.leeway = 0;
    v.set_required_spec_claims(&["exp"]);
    decode::<Claims>(token, &DecodingKey::from_secret(secret.as_bytes()), &v).map(|d| d.claims)
}

/// The PyJWT message for a token that failed to decode, as Python puts it after "Invalid or expired
/// authentication token: " (backend/app/auth.py `decode_access_token`). The cases a client can hit
/// (malformed, wrong key, expired) match PyJWT; rarer ones keep jsonwebtoken's own wording.
pub fn pyjwt_message(token: &str, err: &jsonwebtoken::errors::Error) -> String {
    use jsonwebtoken::errors::ErrorKind;
    if token.split('.').count() < 3 {
        return "Not enough segments".into();
    }
    match err.kind() {
        ErrorKind::InvalidSignature => "Signature verification failed".into(),
        ErrorKind::ExpiredSignature => "Signature has expired".into(),
        _ => err.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Made by backend/app/auth.py hash_password("engineer123")
    const PY_HASH: &str =
        "pbkdf2_sha256$120000$38cbf24e0d3be32112492beb7e741251$9437db0235180b237cb8187029d470f0bb5cb592df01db4aa2031dab405b166b";
    // Made by PyJWT: {"sub": "7", "email": "e@x", "role": "engineer", "full_name": "E", "exp": 2099-01-01}, key "test-secret"
    const PY_TOKEN: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI3IiwiZW1haWwiOiJlQHgiLCJyb2xlIjoiZW5naW5lZXIiLCJmdWxsX25hbWUiOiJFIiwiZXhwIjo0MDcwOTA4ODAwfQ.GBQnXOlf7y8X2lzPSKIvkZjzULci9be7TZwnuFsrnaw";

    fn user() -> User {
        User {
            id: 7,
            username: Some("e".into()),
            email: "e@x".into(),
            full_name: "E".into(),
            hashed_password: PY_HASH.into(),
            role: "engineer".into(),
            is_active: true,
            store_keeper: false,
        }
    }

    #[test]
    fn own_hash_has_python_form_and_verifies() {
        let h = hash_password("s3cret-pass");
        let parts: Vec<&str> = h.split('$').collect();
        assert_eq!((parts[0], parts[1], parts[2].len(), parts[3].len()), ("pbkdf2_sha256", "120000", 32, 64));
        assert!(verify_password("s3cret-pass", &h));
        assert!(!verify_password("s3cret-pasS", &h));
        assert_ne!(hash_password("s3cret-pass"), h, "a new salt each time");
    }

    #[test]
    fn python_hash_verifies() {
        assert!(verify_password("engineer123", PY_HASH));
        assert!(!verify_password("engineer124", PY_HASH));
    }

    #[test]
    fn malformed_hashes_are_rejected() {
        for bad in ["", "pbkdf2_sha256$x$salt$00", "bcrypt$1$s$00", "pbkdf2_sha256$0$s$00", "pbkdf2_sha256$120000$s"] {
            assert!(!verify_password("engineer123", bad), "{bad}");
        }
    }

    #[test]
    fn python_token_decodes() {
        let c = decode_access_token(PY_TOKEN, "test-secret").unwrap();
        assert_eq!((c.sub.as_str(), c.role.as_str(), c.exp), ("7", "engineer", 4_070_908_800));
        assert!(decode_access_token(PY_TOKEN, "other-secret").is_err());
    }

    #[test]
    fn decode_errors_use_pyjwt_messages() {
        let msg = |t: &str| pyjwt_message(t, &decode_access_token(t, "test-secret").unwrap_err());
        assert_eq!(msg("not-a-jwt"), "Not enough segments");
        assert_eq!(msg("a.b"), "Not enough segments");
        assert_eq!(pyjwt_message(PY_TOKEN, &decode_access_token(PY_TOKEN, "other").unwrap_err()), "Signature verification failed");
        let old = create_access_token(&user(), "test-secret", -1).unwrap();
        assert_eq!(msg(&old), "Signature has expired");
    }

    #[test]
    fn own_token_round_trips_and_expires() {
        let t = create_access_token(&user(), "s", 5).unwrap();
        assert_eq!(decode_access_token(&t, "s").unwrap().sub, "7");
        let old = create_access_token(&user(), "s", -1).unwrap();
        assert!(decode_access_token(&old, "s").is_err());
    }
}
