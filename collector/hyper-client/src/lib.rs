use common::client::Client;

pub struct HyperClient {}

impl HyperClient {
    pub fn new() -> Self {
        Self {}
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
            .uri("http://localhost:8126/v0.4/traces")
            .header("Content-Type", "application/msgpack")
            // .header("X-Datadog-Trace-Count", trace_count.to_string())
            // .header("Datadog-Meta-Tracer-Version", "")
            // .header("Datadog-Meta-Lang", "")
            // .header("Datadog-Meta-Lang-Version", "")
            // .header("Datadog-Meta-Lang-Interpreter", "")
            .body(hyper::Body::from(data))
            .unwrap();

        tokio::spawn(async move {
            hyper::Client::new().request(req).await.unwrap();
        });
    }
}
