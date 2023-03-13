use common::client::Client;
use std::sync::mpsc::SyncSender;

pub struct BufferClient {
    tx: Option<SyncSender<Vec<u8>>>
}

impl BufferClient {
    pub fn new() -> Self {
        Self {
            tx: None
        }
    }

    // TODO: Require a sender in `new()` instead.
    pub fn on_response (&mut self, tx: SyncSender<Vec<u8>>) {
        self.tx = Some(tx);
    }
}

impl Default for BufferClient {
    fn default() -> Self {
        Self::new()
    }
}

impl Client for BufferClient {
    fn request(&self, data: Vec<u8>) {
        let tx = self.tx.clone();

        if let Some(tx) = tx {
            tx.send(data).unwrap();
        }
    }
}
