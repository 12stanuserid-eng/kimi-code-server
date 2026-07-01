use reqwest::multipart;
use uuid::Uuid;

use crate::{
    common::types::ChatId, errors::PentaractResult,
    services::storage_workers_scheduler::StorageWorkersScheduler,
};

use super::schemas::{DownloadBodySchema, UploadBodySchema, UploadSchema};

pub struct TelegramBotApi<'t> {
    base_url: &'t str,
    scheduler: StorageWorkersScheduler<'t>,
}

impl<'t> TelegramBotApi<'t> {
    pub fn new(base_url: &'t str, scheduler: StorageWorkersScheduler<'t>) -> Self {
        Self {
            base_url,
            scheduler,
        }
    }

    pub async fn upload(
        &self,
        file: &[u8],
        chat_id: ChatId,
        storage_id: Uuid,
    ) -> PentaractResult<UploadSchema> {
        // chat_id is already in the correct Telegram format (e.g., -1003998671748)
        // with the -100 prefix for supergroups/channels, so we use it directly.
        // The transformation formula from StackOverflow is for raw IDs without the prefix.

        let token = self.scheduler.get_token(storage_id).await?;
        let url = self.build_url("", "sendDocument", token);

        let file_part = multipart::Part::bytes(file.to_vec()).file_name("pentaract_chunk.bin");
        let form = multipart::Form::new()
            .text("chat_id", chat_id.to_string())
            .part("document", file_part);

        let response = reqwest::Client::new()
            .post(url)
            .multipart(form)
            .send()
            .await?;

        match response.error_for_status() {
            // https://stackoverflow.com/a/32679930/12255756
            Ok(r) => Ok(r.json::<UploadBodySchema>().await?.result.document),
            Err(e) => Err(e.into()),
        }
    }

    pub async fn download(
        &self,
        telegram_file_id: &str,
        storage_id: Uuid,
    ) -> PentaractResult<Vec<u8>> {
        // getting file path
        let token = self.scheduler.get_token(storage_id).await?;
        let url = self.build_url("", "getFile", token);
        // TODO: add retries with their number taking from env
        let body: DownloadBodySchema = reqwest::Client::new()
            .get(url)
            .query(&[("file_id", telegram_file_id)])
            .send()
            .await?
            .json()
            .await?;

        // downloading the file itself
        let token = self.scheduler.get_token(storage_id).await?;
        let url = self.build_url("file/", &body.result.file_path, token);
        let file = reqwest::get(url)
            .await?
            .bytes()
            .await
            .map(|file| file.to_vec())?;

        Ok(file)
    }

    /// Taking token by a value to force dropping it so it can be used only once
    #[inline]
    fn build_url(&self, pre: &str, relative: &str, token: String) -> String {
        format!("{}/{pre}bot{token}/{relative}", self.base_url)
    }
}
