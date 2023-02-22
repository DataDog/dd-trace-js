use hyper::{Body, Error, Method, Server, Version};
use hyper::http::Response;
use hyper::service::{make_service_fn, service_fn};
use rmp::encode;
use rmp::encode::ByteBuf;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
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

#[derive(Deserialize, Debug)]
struct Metadata {
    service: String
}

#[derive(Deserialize, Debug)]
struct Payload {
    metadata: Metadata,
    events: Vec<Value>
}

// TODO: Decouple processing from transport.
// TODO: Cleanup traces on connection close.
// TODO: Read MsgPack manually and copy bytes to span buffer directly.
// TODO: Add support for more payload metadata (i.e. language).
// TODO: Use string table.
// TODO: Read events into structs instead of serde values.
// TODO: Event for adding trace tags.
// TODO: Event for adding baggage items.
// TODO: Add support for sampling.
// TODO: Support sending traces directly to Datadog.
// TODO: Optimize to minimize allocations and copies.
// TODO: Split in modules.
// TODO: Add tests.
// TODO: Add benchmarks.

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let addr = ([127, 0, 0, 1], 8127).into();
    let make_svc = make_service_fn(|_conn| {
        let (tx, mut rx): (Sender<Payload>, Receiver<Payload>) = mpsc::channel(100);

        tokio::spawn(async move {
            let mut traces = Traces::new();

            while let Some(payload) = rx.recv().await {
                // println!("{:#?}", payload);

                let metadata = payload.metadata;
                let events = payload.events;

                for event in events {
                    process_event(&mut traces, event, &metadata);
                }

                flush(&mut traces).await;
            }
        });

        async move {
            Ok::<_, Error>(service_fn(move |mut req| {
                let tx = tx.clone();

                async move {
                    let method = req.method();
                    let path = req.uri().path();
                    let version = req.version();

                    if version == Version::HTTP_11 && method == Method::PUT && path == "/v0.1/events" {
                        let bytes = hyper::body::to_bytes(req.body_mut()).await.unwrap();
                        let data: Vec<u8> = bytes.try_into().unwrap();
                        let payload: Payload = rmp_serde::from_slice(&data).unwrap();

                        tx.send(payload).await.unwrap();

                        Ok(Response::new(Body::from("")))
                    } else {
                        Err("Unsupported request") // TODO: not a 500
                    }
                }
            }))
        }
    });

    let server = Server::bind(&addr).serve(make_svc);

    println!("Listening on http://{}", addr);

    server.await?;

    Ok(())
}

fn process_event(traces: &mut Traces, event: Value, metadata: &Metadata) {
    let event_type = event.get(0).unwrap().as_u64().unwrap();

    match event_type {
        1 => process_start_koa_request(traces, &event, &metadata),
        2 => process_add_error(traces, &event),
        3 => process_finish_koa_request(traces, &event),
        4 => process_start_span(traces, &event, &metadata),
        5 => process_finish_span(traces, &event),
        6 => process_add_tags(traces, &event),
        _ => ()
    }
}

fn process_add_error(traces: &mut Traces, event: &Value) {
    let maybe_trace = traces.get_mut(&event[2].as_u64().unwrap());

    match maybe_trace {
        Some(trace) => {
            let maybe_span = trace.spans.get_mut(&event[3].as_u64().unwrap());

            match maybe_span {
                Some(mut span) => {
                    span.error = 1;
                    span.meta.insert(String::from("error.type"), event[4].as_str().unwrap().to_string());
                    span.meta.insert(String::from("error.message"), event[5].as_str().unwrap().to_string());
                    span.meta.insert(String::from("error.stack"), event[6].as_str().unwrap().to_string());
                },
                None => ()
            }
        },
        None => ()
    }
}

fn process_add_tags(traces: &mut Traces, event: &Value) {
    let maybe_trace = traces.get_mut(&event[2].as_u64().unwrap());

    match maybe_trace {
        Some(trace) => {
            let maybe_span = trace.spans.get_mut(&event[3].as_u64().unwrap());

            match maybe_span {
                Some(span) => {
                    add_tags_from_value(span, &event[4]);
                },
                None => ()
            }
        },
        None => ()
    }
}

fn process_start_span(traces: &mut Traces, event: &Value, metadata: &Metadata) {
    let mut meta = HashMap::new();
    let mut metrics = HashMap::new();

    for (k, v) in event[9].as_object().unwrap() {
        match v {
            Value::Number(v) => {
                metrics.insert(k.to_string(), v.as_f64().unwrap());
            },
            Value::String(v) => {
                meta.insert(k.to_string(), v.to_string());
            }
            _ => ()
        }
    }

    let span_type = event[5].as_str().unwrap();
    let service = event[8].as_str().unwrap();
    let mut span = Span {
        span_type: if span_type.is_empty() { None } else { Some(span_type.to_string()) },
        trace_id: event[2].as_u64().unwrap(),
        span_id: event[3].as_u64().unwrap(),
        parent_id: event[4].as_u64().unwrap(),
        name: event[6].as_str().unwrap().to_string(),
        resource: event[7].as_str().unwrap().to_string(),
        service: if service.is_empty() { metadata.service.to_string() } else { service.to_string() },
        error: 0,
        start: event[1].as_u64().unwrap(),
        duration: 0,
        meta,
        metrics
    };

    add_tags_from_value(&mut span, &event[9]);

    start_span(traces, span);
}

fn process_finish_span(traces: &mut Traces, event: &Value) {
    let maybe_trace = traces.get_mut(&event[2].as_u64().unwrap());

    match maybe_trace {
        Some(mut trace) => {
            let maybe_span = trace.spans.get_mut(&event[3].as_u64().unwrap());

            match maybe_span {
                Some(mut span) => {
                    trace.finished += 1;

                    span.duration = event[1].as_u64().unwrap() - span.start;

                    add_tags_from_value(span, &event[4]);
                },
                None => ()
            }
        },
        None => ()
    }
}

fn process_start_koa_request(traces: &mut Traces, event: &Value, metadata: &Metadata) {
    let mut meta = HashMap::new();
    let metrics = HashMap::new();

    let method = event[5].as_str().unwrap().to_string();
    let url = event[6].as_str().unwrap().to_string(); // TODO: route not url
    let resource = format!("{method} {url}");

    meta.insert(String::from("http.method"), method);
    meta.insert(String::from("http.url"), url);

    let span = Span {
        span_type: Some(String::from("web")),
        trace_id: event[2].as_u64().unwrap(),
        span_id: event[3].as_u64().unwrap(),
        parent_id: event[4].as_u64().unwrap(),
        name: String::from("koa.request"),
        resource,
        service: metadata.service.to_string(),
        error: 0,
        start: event[1].as_u64().unwrap(),
        duration: 0,
        meta,
        metrics
    };

    start_span(traces, span);
}

fn process_finish_koa_request(traces: &mut Traces, event: &Value) {
    let maybe_trace = traces.get_mut(&event[2].as_u64().unwrap());

    match maybe_trace {
        Some(mut trace) => {
            let maybe_span = trace.spans.get_mut(&event[3].as_u64().unwrap());

            match maybe_span {
                Some(mut span) => {
                    trace.finished += 1;

                    span.duration = event[1].as_u64().unwrap() - span.start;
                    span.meta.insert(String::from("http.status_code"), event[4].as_u64().unwrap().to_string());
                },
                None => ()
            }
        },
        None => ()
    }
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

fn add_tags_from_value(span: &mut Span, value: &Value) {
    for (k, v) in value.as_object().unwrap() {
        match v {
            Value::Number(v) => {
                span.metrics.insert(k.to_string(), v.as_f64().unwrap());
            },
            Value::String(v) => {
                span.meta.insert(k.to_string(), v.to_string());
            }
            _ => ()
        }
    }
}

async fn flush(traces: &mut Traces) {
    let mut wr = ByteBuf::new();
    let finished_traces: Vec<&Trace> = traces.values().filter(|t| t.started == t.finished).collect();
    let trace_count = finished_traces.len();

    if trace_count > 0 {
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
