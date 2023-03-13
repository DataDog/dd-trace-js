use common::exporting::agent::AgentExporter;
use common::processing::Processor;
use hyper_client::HyperClient;
use tokio::sync::mpsc::{self, Receiver, Sender};

extern crate libc;

#[no_mangle]
pub extern "C" fn submit(size: usize, ptr: *const u8) -> u32 {
    internal_submit(unsafe {
        std::slice::from_raw_parts(ptr as *const u8, size as usize)
    }) as u32
}

#[tokio::main]
async fn internal_submit(payload: &[u8]) -> u32 {
    let (tx, mut rx): (Sender<()>, Receiver<()>) = mpsc::channel(1);

    let mut client = Box::new(HyperClient::new());

    client.on_response(tx);

    let exporter = Box::new(AgentExporter::new(client));
    let mut processor = Processor::new(exporter);
    let mut rd = payload;

    processor.process(&mut rd);
    processor.flush();

    rx.recv().await.unwrap();

    0 // TODO: Return proper response buffer instead.
}
