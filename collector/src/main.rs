use hyper::body::{Buf, Bytes};
use hyper::{Body, Method, StatusCode};
use hyper::http::Response;
use hyper::server::conn::Http;
use hyper::service::service_fn;
use rmp::decode::{NumValueReadError, read_array_len, read_f64, read_map_len, read_str_len};
use rmp::encode;
use rmp::encode::ByteBuf;
use std::collections::HashMap;
use std::io::Read;
use std::net::SocketAddr;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::sync::mpsc::{Receiver,Sender};

type Traces = HashMap<u64, Trace>;

#[derive(Debug)]
struct Span {
    span_type: Option<String>,
    trace_id: u64,
    span_id: u64,
    parent_id: u64,
    name: String,
    resource: String,
    service: String,
    error: u64,
    start: u64,
    duration: u64,
    meta: HashMap<String, String>,
    metrics: HashMap<String, f64>
}

#[derive(Debug)]
struct Trace {
    started: u64,
    finished: u64,
    spans: HashMap<u64, Span>
}

// TODO: Decouple processing from transport.
// TODO: Stream the data somehow.
// TODO: Make sure that traces are cleaned up on connection close.
// TODO: Add support for more payload metadata (i.e. language).
// TODO: Use 0.5 endpoint.
// TODO: Event for adding trace tags.
// TODO: Event for adding baggage items.
// TODO: Add support for sampling.
// TODO: Support sending traces directly to Datadog.
// TODO: Optimize to minimize allocations and copies.
// TODO: Split in modules.
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
            let mut traces = Traces::new();

            while let Some(payload) = rx.recv().await {
                let mut rd = payload.reader();

                read_array_len(&mut rd).unwrap();

                let string_count = read_array_len(&mut rd).unwrap();
                let mut strings: Vec<String> = Vec::with_capacity(string_count as usize);

                for _ in 0..string_count {
                    strings.push(read_str(&mut rd));
                }

                let event_count = read_array_len(&mut rd).unwrap();

                for _ in 0..event_count {
                    process_event(&mut traces, &strings, &mut rd);
                }

                flush(&mut traces).await;
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

fn process_event<R: Read>(traces: &mut Traces, strings: &[String], mut rd: R) {
    read_array_len(&mut rd).unwrap();

    let event_type = read_u64(&mut rd).unwrap();

    match event_type {
        1 => process_start_koa_request(traces, strings, rd),
        2 => process_add_error(traces, strings, rd),
        3 => process_finish_koa_request(traces, strings, rd),
        4 => process_start_span(traces, strings, rd),
        5 => process_finish_span(traces, strings, rd),
        6 => process_add_tags(traces, strings, rd),
        _ => ()
    }
}

fn process_add_error<R: Read>(traces: &mut Traces, strings: &[String], mut rd: R) {
    let size = read_array_len(&mut rd).unwrap();

    read_u64(&mut rd).unwrap();

    let trace_id = read_u64(&mut rd).unwrap();
    let span_id = read_u64(&mut rd).unwrap();
    let message = if size >= 4 {
        &strings[read_u32(&mut rd).unwrap() as usize]
    } else {
        ""
    };
    let stack = if size >= 5 {
        &strings[read_u32(&mut rd).unwrap() as usize]
    } else {
        ""
    };
    let name = if size >= 6 {
        &strings[read_u32(&mut rd).unwrap() as usize]
    } else {
        ""
    };

    if let Some(trace) = traces.get_mut(&trace_id) {
        if let Some(mut span) = trace.spans.get_mut(&span_id) {
            span.error = 1;

            if !message.is_empty() {
                span.meta.insert(String::from("error.message"), String::from(message));
            }

            if !stack.is_empty() {
                span.meta.insert(String::from("error.stack"), String::from(stack));
            }

            if !name.is_empty() {
                span.meta.insert(String::from("error.type"), String::from(name));
            }
        }
    }
}

fn process_add_tags<R: Read>(traces: &mut Traces, strings: &[String], mut rd: R) {
    read_array_len(&mut rd).unwrap();
    read_u64(&mut rd).unwrap();

    let trace_id = read_u64(&mut rd).unwrap();
    let span_id = read_u64(&mut rd).unwrap();
    let (meta, metrics) = read_tags(&mut rd, strings);

    if let Some(trace) = traces.get_mut(&trace_id) {
        if let Some(span) = trace.spans.get_mut(&span_id) {
            span.meta.extend(meta);
            span.metrics.extend(metrics);
        }
    }
}

fn process_start_span<R: Read>(traces: &mut Traces, strings: &[String], mut rd: R) {
    let size = read_array_len(&mut rd).unwrap();
    let start = read_u64(&mut rd).unwrap();
    let trace_id = read_u64(&mut rd).unwrap();
    let span_id = read_u64(&mut rd).unwrap();
    let parent_id = read_u64(&mut rd).unwrap();
    let service = strings[read_u32(&mut rd).unwrap() as usize].to_owned();
    let name = strings[read_u32(&mut rd).unwrap() as usize].to_owned();
    let resource = strings[read_u32(&mut rd).unwrap() as usize].to_owned();
    let (meta, metrics) = read_tags(&mut rd, strings);
    let span_type: Option<String> = if size >= 10 {
        Some(strings[read_u32(&mut rd).unwrap() as usize].to_owned())
    } else {
        None
    };

    let span = Span {
        start,
        trace_id,
        span_id,
        parent_id,
        span_type,
        name,
        resource,
        service,
        error: 0,
        duration: 0,
        meta,
        metrics
    };

    start_span(traces, span);
}

fn process_finish_span<R: Read>(traces: &mut Traces, strings: &[String], mut rd: R) {
    read_array_len(&mut rd).unwrap();

    let start = read_u64(&mut rd).unwrap();
    let trace_id = read_u64(&mut rd).unwrap();
    let span_id = read_u64(&mut rd).unwrap();
    let (meta, metrics) = read_tags(&mut rd, strings);

    if let Some(mut trace) = traces.get_mut(&trace_id) {
        if let Some(mut span) = trace.spans.get_mut(&span_id) {
            trace.finished += 1;

            span.duration = start - span.start;

            span.meta.extend(meta);
            span.metrics.extend(metrics);
        }
    }
}

fn process_start_koa_request<R: Read>(traces: &mut Traces, strings: &[String], mut rd: R) {
    let mut meta = HashMap::new();
    let metrics = HashMap::new();

    read_array_len(&mut rd).unwrap();

    let start = read_u64(&mut rd).unwrap();
    let trace_id = read_u64(&mut rd).unwrap();
    let span_id = read_u64(&mut rd).unwrap();
    let parent_id = read_u64(&mut rd).unwrap();
    let method = strings[read_u32(&mut rd).unwrap() as usize].to_owned();
    let url = strings[read_u32(&mut rd).unwrap() as usize].to_owned(); // TODO: route not url

    let resource = format!("{method} {url}");

    meta.insert(String::from("http.method"), method);
    meta.insert(String::from("http.url"), url);

    let span = Span {
        start,
        trace_id,
        span_id,
        parent_id,
        span_type: Some(String::from("web")),
        name: String::from("koa.request"),
        resource,
        service: String::from("unnamed-app"),
        error: 0,
        duration: 0,
        meta,
        metrics
    };

    start_span(traces, span);
}

fn process_finish_koa_request<R: Read>(traces: &mut Traces, _: &[String], mut rd: R) {
    read_array_len(&mut rd).unwrap();

    let start = read_u64(&mut rd).unwrap();
    let trace_id = read_u64(&mut rd).unwrap();
    let span_id = read_u64(&mut rd).unwrap();
    let status_code = read_u16(&mut rd).unwrap().to_string();

    if let Some(mut trace) = traces.get_mut(&trace_id) {
        if let Some(mut span) = trace.spans.get_mut(&span_id) {
            trace.finished += 1;

            span.duration = start - span.start;
            span.meta.insert(String::from("http.status_code"), status_code);
        }
    }
}

fn read_u16<R: Read>(mut rd: R) -> Result<u16, NumValueReadError> {
    rmp::decode::read_int(&mut rd)
}

fn read_u32<R: Read>(mut rd: R) -> Result<u32, NumValueReadError> {
    rmp::decode::read_int(&mut rd)
}

fn read_u64<R: Read>(mut rd: R) -> Result<u64, NumValueReadError> {
    rmp::decode::read_int(&mut rd)
}

fn read_str<R: Read>(mut rd: R) -> String {
    let limit = read_str_len(&mut rd).unwrap() as u64;
    let mut str = String::new();

    rd.by_ref().take(limit).read_to_string(&mut str).unwrap();

    str
}

fn read_tags<R: Read>(mut rd: R, strings: &[String]) -> (HashMap<String, String>, HashMap<String, f64>){
    let mut meta = HashMap::new();
    let mut metrics = HashMap::new();

    let meta_size = read_map_len(&mut rd).unwrap();

    for _ in 0..meta_size {
        meta.insert(
            strings[read_u32(&mut rd).unwrap() as usize].to_owned(),
            strings[read_u32(&mut rd).unwrap() as usize].to_owned()
        );
    }

    let metrics_size = read_map_len(&mut rd).unwrap();

    for _ in 0..metrics_size {
        metrics.insert(
            strings[read_u32(&mut rd).unwrap() as usize].to_owned(),
            read_f64(&mut rd).unwrap()
        );
    }

    (meta, metrics)
}

fn start_span(traces: &mut Traces, span: Span) {
    let trace = traces.entry(span.trace_id).or_insert(Trace {
        started: 0,
        finished: 0,
        spans: HashMap::new()
    });

    trace.started += 1;
    trace.spans.insert(span.span_id, span);
}

async fn flush(traces: &mut Traces) {
    let mut wr = ByteBuf::new();
    let finished_traces: Vec<&Trace> = traces.values().filter(|t| t.started == t.finished).collect();
    let trace_count = finished_traces.len();

    if trace_count > 0 {
        // println!("{:#?}", finished_traces);

        encode_traces(&mut wr, finished_traces);

        traces.retain(|_, t| t.started != t.finished);

        let client = hyper::Client::new();
        let data: Vec<u8> = wr.as_vec().to_vec();
        let req = hyper::Request::builder()
            .method(hyper::Method::PUT)
            .uri("http://localhost:8126/v0.4/traces")
            .header("Content-Type", "application/msgpack")
            .header("X-Datadog-Trace-Count", trace_count.to_string())
            // .header("Datadog-Meta-Tracer-Version", "")
            // .header("Datadog-Meta-Lang", "")
            // .header("Datadog-Meta-Lang-Version", "")
            // .header("Datadog-Meta-Lang-Interpreter", "")
            .body(hyper::Body::from(data))
            .unwrap();

        client.request(req).await.unwrap();
    }
}

fn encode_traces(wr: &mut ByteBuf, traces: Vec<&Trace>) {
    encode::write_array_len(wr, traces.len() as u32).unwrap();

    for trace in traces {
        encode_trace(wr, trace);
    }
}

fn encode_trace(wr: &mut ByteBuf, trace: &Trace) {
    encode::write_array_len(wr, trace.spans.len() as u32).unwrap();

    for span in trace.spans.values() {
        match &span.span_type {
            Some(span_type) => {
                encode::write_map_len(wr, 12).unwrap();
                encode::write_str(wr, "type").unwrap();
                encode::write_str(wr, span_type.as_str()).unwrap();
            },
            None => {
                encode::write_map_len(wr, 11).unwrap();
            }
        }

        encode::write_str(wr, "trace_id").unwrap();
        encode::write_uint(wr, span.trace_id).unwrap();
        encode::write_str(wr, "span_id").unwrap();
        encode::write_uint(wr, span.span_id).unwrap();
        encode::write_str(wr, "parent_id").unwrap();
        encode::write_uint(wr, span.parent_id).unwrap();
        encode::write_str(wr, "name").unwrap();
        encode::write_str(wr, span.name.as_str()).unwrap();
        encode::write_str(wr, "resource").unwrap();
        encode::write_str(wr, span.resource.as_str()).unwrap();
        encode::write_str(wr, "service").unwrap();
        encode::write_str(wr, span.service.as_str()).unwrap();
        encode::write_str(wr, "error").unwrap();
        encode::write_uint(wr, span.error).unwrap();
        encode::write_str(wr, "start").unwrap();
        encode::write_uint(wr, span.start).unwrap();
        encode::write_str(wr, "duration").unwrap();
        encode::write_uint(wr, span.duration + 1).unwrap();

        encode_meta(wr, &span.meta);
        encode_metrics(wr, &span.metrics);
    }
}

fn encode_meta(wr: &mut ByteBuf, map: &HashMap<String, String>) {
    encode::write_str(wr, "meta").unwrap();
    encode::write_map_len(wr, map.len() as u32).unwrap();

    for (k, v) in map {
        encode::write_str(wr, k.as_str()).unwrap();
        encode::write_str(wr, v.as_str()).unwrap();
    }
}

fn encode_metrics(wr: &mut ByteBuf, map: &HashMap<String, f64>) {
    encode::write_str(wr, "metrics").unwrap();
    encode::write_map_len(wr, map.len() as u32).unwrap();

    for (k, v) in map {
        encode::write_str(wr, k.as_str()).unwrap();
        encode::write_f64(wr, *v).unwrap();
    }
}
