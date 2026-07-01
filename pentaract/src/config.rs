use std::{env, str::FromStr};

use super::errors::{PentaractError, PentaractResult};

/// Percent-encode special characters in a string for safe inclusion in a URI.
/// This is needed because the database password may contain characters like `@`
/// that break URI parsing when used directly in the `postgres://` connection string.
fn url_encode_password(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            // Unreserved characters per RFC 3986
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(byte as char);
            }
            // Everything else gets percent-encoded
            _ => {
                result.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    result
}

#[derive(Debug, Clone)]
pub struct Config {
    pub db_uri: String,
    pub db_uri_without_dbname: String,
    pub db_name: String,
    pub db_ssl_mode: String,
    pub port: u16,
    pub workers: u16,
    pub channel_capacity: u16,
    pub superuser_email: String,
    pub superuser_pass: String,

    pub access_token_expire_in_secs: u32,
    pub refresh_token_expire_in_days: u16,
    pub secret_key: String,

    pub telegram_api_base_url: String,
    pub telegram_rate_limit: u8,
}

impl Config {
    pub fn new() -> PentaractResult<Self> {
        let db_user: String = Self::get_env_var("DATABASE_USER")?;
        let db_password: String = Self::get_env_var("DATABASE_PASSWORD")?;
        let db_name: String = Self::get_env_var("DATABASE_NAME")?;
        let db_host: String = Self::get_env_var("DATABASE_HOST")?;
        let db_port: String = Self::get_env_var("DATABASE_PORT")?;
        let db_ssl_mode = Self::get_env_var_with_default("DATABASE_SSL_MODE", "require".to_string())?;
        let encoded_password = url_encode_password(&db_password);
        let db_uri = {
            format!(
                "postgres://{db_user}:{encoded_password}@{db_host}:{db_port}/{db_name}?sslmode={db_ssl_mode}"
            )
        };
        let db_uri_without_dbname = {
            format!(
                "postgres://{db_user}:{encoded_password}@{db_host}:{db_port}/{db_name}?sslmode={db_ssl_mode}"
            )
        };
        let port = Self::get_env_var("PORT")?;
        let workers = Self::get_env_var("WORKERS")?;
        let channel_capacity = Self::get_env_var("CHANNEL_CAPACITY")?;
        let superuser_email = Self::get_env_var("SUPERUSER_EMAIL")?;
        let superuser_pass = Self::get_env_var("SUPERUSER_PASS")?;
        let access_token_expire_in_secs = Self::get_env_var("ACCESS_TOKEN_EXPIRE_IN_SECS")?;
        let refresh_token_expire_in_days = Self::get_env_var("REFRESH_TOKEN_EXPIRE_IN_DAYS")?;
        let secret_key = Self::get_env_var("SECRET_KEY")?;
        let telegram_api_base_url = Self::get_env_var("TELEGRAM_API_BASE_URL")?;
        let telegram_rate_limit = Self::get_env_var_with_default("TELEGRAM_RATE_LIMIT", 18)?;

        Ok(Self {
            db_uri,
            db_uri_without_dbname,
            db_name,
            db_ssl_mode,
            port,
            workers,
            channel_capacity,
            superuser_email,
            superuser_pass,
            access_token_expire_in_secs,
            refresh_token_expire_in_days,
            secret_key,
            telegram_api_base_url,
            telegram_rate_limit,
        })
    }

    #[inline]
    fn get_env_var<T: FromStr>(env_var: &str) -> PentaractResult<T> {
        env::var(env_var)
            .map_err(|_| PentaractError::EnvConfigLoadingError(env_var.to_owned()))?
            .parse::<T>()
            .map_err(|_| PentaractError::EnvVarParsingError(env_var.to_owned()))
    }

    #[inline]
    fn get_env_var_with_default<T: FromStr>(env_var: &str, default: T) -> PentaractResult<T> {
        let result = Self::get_env_var(env_var);

        if matches!(result, Err(PentaractError::EnvConfigLoadingError(_))) {
            return Ok(default);
        }

        result
    }
}
