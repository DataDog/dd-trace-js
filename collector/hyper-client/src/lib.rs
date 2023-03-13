use common::client::Client;
use tokio::sync::mpsc::Sender;

pub struct HyperClient {
    tx: Option<Sender<()>>
}

impl HyperClient {
    pub fn new() -> Self {
        Self {
            tx: None
        }
    }

    // TODO: Require a sender in `new()` instead.
    pub fn on_response (&mut self, tx: Sender<()>) {
        self.tx = Some(tx);
    }
}

impl Default for HyperClient {
    fn default() -> Self {
        Self::new()
    }
}

impl Client for HyperClient {
    fn request(&self, data: Vec<u8>) {
        // TODO: configuration options
        let req = hyper::Request::builder()
            .method(hyper::Method::PUT)
            .uri("http://localhost:8126/v0.5/traces")
            .header("Content-Type", "application/msgpack")
            // .header("X-Datadog-Trace-Count", trace_count.to_string())
            // .header("Datadog-Meta-Tracer-Version", "")
            // .header("Datadog-Meta-Lang", "")
            // .header("Datadog-Meta-Lang-Version", "")
            // .header("Datadog-Meta-Lang-Interpreter", "")
            .body(hyper::Body::from(data))
            .unwrap();

        let tx = self.tx.clone();

        tokio::spawn(async move {
            let res = hyper::Client::new().request(req).await.unwrap();

            // Discard the response for now.
            hyper::body::to_bytes(res.into_body()).await.unwrap();

            if let Some(tx) = tx {
                tx.send(()).await.unwrap();
            }
        });
    }
}
