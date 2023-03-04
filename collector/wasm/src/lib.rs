
use client::BufferClient;
use common::exporting::agent::AgentExporter;
use common::processing::Processor;
use std::sync::mpsc::{SyncSender, Receiver, self};
use wasm_bindgen::prelude::*;

pub mod client;

// TODO: Use WASI to submit from here instead of just returning the data.

#[wasm_bindgen]
pub fn collect(payload: &[u8]) -> Vec<u8> {
    let (tx, rx): (SyncSender<Vec<u8>>, Receiver<Vec<u8>>) = mpsc::sync_channel(1);

    let mut client = Box::new(BufferClient::new());

    client.on_response(tx);

    let exporter = Box::new(AgentExporter::new(client));
    let mut processor = Processor::new(exporter);
    let mut rd = payload;

    processor.process(&mut rd);
    processor.flush();

    rx.recv().unwrap()
}
