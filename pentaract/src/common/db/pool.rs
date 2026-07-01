use std::time::Duration;

use sqlx::{postgres::PgPoolOptions, PgPool};
use tokio::time;
use tracing::warn;

pub async fn get_pool(dsn: &str, max_connection: u32, timeout: Duration) -> PgPool {
    let max_retries: u32 = 10;
    let mut delay = Duration::from_secs(1);

    // Initial connection attempt
    if let Ok(pool) = PgPoolOptions::new()
        .max_connections(max_connection)
        .acquire_timeout(timeout)
        .connect(dsn)
        .await
    {
        tracing::debug!("established connection with database");
        return pool;
    }

    // Retry with exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (capped)
    for attempt in 1..=max_retries {
        let result = PgPoolOptions::new()
            .max_connections(max_connection)
            .acquire_timeout(timeout)
            .connect(dsn)
            .await;

        match result {
            Ok(pool) => {
                tracing::debug!("established connection with database");
                return pool;
            }
            Err(e) => {
                if attempt == max_retries {
                    panic!(
                        "can't establish database connection after {} retries: {}",
                        max_retries, e
                    );
                }

                warn!(
                    attempt,
                    max_retries,
                    retry_delay_ms = delay.as_millis(),
                    error = %e,
                    "failed to connect to database, retrying"
                );

                time::sleep(delay).await;
                delay = std::cmp::min(delay * 2, Duration::from_secs(30));
            }
        }
    }

    unreachable!()
}
