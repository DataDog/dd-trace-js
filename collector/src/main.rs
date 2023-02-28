use ddcollector::exporting::agent::AgentExporter;
use ddcollector::processing::Processor;
use hyper::body::{Buf, Bytes};
use hyper::{Body, Method, StatusCode};
use hyper::http::Response;
use hyper::server::conn::Http;
use hyper::service::service_fn;
use std::net::SocketAddr;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::sync::mpsc::{Receiver,Sender};

// TODO: Move HTTP server to its own module.
// TODO: Stream the data somehow.
// TODO: Make sure that processor is cleaned up on connection close.
// TODO: Add proper error handling.
// TODO: Add tests.
// TODO: Add benchmarks.

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let addr = SocketAddr::from(([127, 0, 0, 1], 8127));
    let listener = TcpListener::bind(addr).await?;

    loop {
        let (stream, _) = listener.accept().await?;
        let (tx, mut rx): (Sender<Bytes>, Receiver<Bytes>) = mpsc::channel(100);

        tokio::spawn(async move {
            while let Some(payload) = rx.recv().await {
                let exporter = Box::new(AgentExporter::new());
                let mut processor = Processor::new(exporter);
                let mut rd = payload.reader();

                processor.process(&mut rd);
                processor.flush();
            }
        });

        tokio::spawn(async move {
            Http::new()
                .http1_only(true)
                .http1_keep_alive(true)
                .serve_connection(stream, service_fn(move |mut req| {
                    let tx = tx.clone();

                    async move {
                        let body;

                        match (req.method(), req.uri().path()) {
                            (&Method::PUT, "/v0.1/events") => {
                                // TODO: use body::aggregate instead
                                let bytes = hyper::body::to_bytes(req.body_mut()).await?;

                                tx.send(bytes).await.unwrap();

                                body = Response::new(Body::from(""));
                            },
                            _ => {
                                body = Response::builder()
                                    .status(StatusCode::NOT_FOUND)
                                    .body(Body::from(""))
                                    .unwrap()
                            }
                        }

                        Ok::<_, hyper::Error>(body)
                    }
                }))
                .await
                .unwrap();
        });
    }
}
