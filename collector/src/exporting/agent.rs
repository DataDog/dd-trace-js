use std::rc::Rc;

use crate::tracing::{Trace, Traces, Meta, Metrics, Span};
use super::Exporter;
use hashbrown::HashMap;
use hyper::{Body, Client, Request};
use rmp::encode;
use rmp::encode::ByteBuf;

pub struct AgentExporter {}

impl Exporter for AgentExporter {
    fn export(&self, traces: Traces) {
        let mut wr = ByteBuf::new();
        let trace_count = traces.len();

        if trace_count > 0 {
            // println!("{:#?}", traces);

            self.encode_traces(&mut wr, traces);

            let data: Vec<u8> = wr.as_vec().to_vec();
            let req = Request::builder()
                .method(hyper::Method::PUT)
                .uri("http://localhost:8126/v0.5/traces")
                .header("Content-Type", "application/msgpack")
                .header("X-Datadog-Trace-Count", trace_count.to_string())
                // .header("Datadog-Meta-Tracer-Version", "")
                // .header("Datadog-Meta-Lang", "")
                // .header("Datadog-Meta-Lang-Version", "")
                // .header("Datadog-Meta-Lang-Interpreter", "")
                .body(Body::from(data))
                .unwrap();

            // TODO: Get the response somehow (with a channel?)
            // TODO: Reuse client.
            tokio::spawn(async move {
                Client::new().request(req).await.unwrap();
            });
        }
    }
}

impl Default for AgentExporter {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentExporter {
    pub fn new() -> Self {
        Self {}
    }

    fn cache_strings(&self, strings: &mut Vec<Rc<str>>, positions: &mut HashMap<Rc<str>, u32>, trace: &Trace) {
        for span in trace.spans.values() {
            self.cache_string(strings, positions, &span.service);
            self.cache_string(strings, positions, &span.name);
            self.cache_string(strings, positions, &span.resource);
            self.cache_string(strings, positions, &span.span_type);

            for (k, v) in &span.meta {
                self.cache_string(strings, positions, &k);
                self.cache_string(strings, positions, &v);
            }

            for (k, _) in &span.metrics {
                self.cache_string(strings, positions, &k);
            }
        }
    }

    fn cache_string(&self, strings: &mut Vec<Rc<str>>, positions: &mut HashMap<Rc<str>, u32>, s: &Rc<str>) {
        if !positions.contains_key(s) {
            let len = strings.len() as u32;

            positions.insert(s.clone(), len);
            strings.push(s.clone());
        }
    }

    fn encode_strings(&self, wr: &mut ByteBuf, strings: &mut Vec<Rc<str>>) {
        encode::write_array_len(wr, strings.len() as u32).unwrap();

        for s in strings {
            encode::write_str(wr, s).unwrap();
        }
    }

    fn encode_traces(&self, wr: &mut ByteBuf, traces: Traces) {
        encode::write_array_len(wr, 2).unwrap();

        let empty_string: Rc<str> = Rc::from("");
        let mut strings = Vec::new();
        let mut positions = HashMap::new();

        strings.push(empty_string.clone());
        positions.insert(empty_string.clone(), 0u32);

        // TODO: Avoid looping twice over traces/strings.
        for trace in traces.values() {
            self.cache_strings(&mut strings, &mut positions, trace);
        }

        self.encode_strings(wr, &mut strings);

        encode::write_array_len(wr, traces.len() as u32).unwrap();

        for trace in traces.values() {
            self.encode_trace(wr, trace, &positions);
        }
    }

    fn encode_trace(&self, wr: &mut ByteBuf, trace: &Trace, positions: &HashMap<Rc<str>, u32>) {
        encode::write_array_len(wr, trace.spans.len() as u32).unwrap();

        for span in trace.spans.values() {
            self.encode_span(wr, span, positions);
        }
    }

    fn encode_span(&self, wr: &mut ByteBuf, span: &Span, positions: &HashMap<Rc<str>, u32>) {
        encode::write_array_len(wr, 12).unwrap();

        encode::write_uint(wr, positions[&span.service] as u64).unwrap();
        encode::write_uint(wr, positions[&span.name] as u64).unwrap();
        encode::write_uint(wr, positions[&span.resource] as u64).unwrap();
        encode::write_uint(wr, span.trace_id).unwrap();
        encode::write_uint(wr, span.span_id).unwrap();
        encode::write_uint(wr, span.parent_id).unwrap();
        encode::write_uint(wr, span.start).unwrap();
        encode::write_uint(wr, span.duration + 1).unwrap();
        encode::write_uint(wr, span.error).unwrap();
        self.encode_meta(wr, &span.meta, positions);
        self.encode_metrics(wr, &span.metrics, positions);
        encode::write_uint(wr, positions[&span.span_type] as u64).unwrap();
    }

    fn encode_meta(&self, wr: &mut ByteBuf, meta: &Meta, positions: &HashMap<Rc<str>, u32>) {
        encode::write_map_len(wr, meta.len() as u32).unwrap();

        for (k, v) in meta {
            encode::write_uint(wr, positions[k] as u64).unwrap();
            encode::write_uint(wr, positions[v] as u64).unwrap();
        }
    }

    fn encode_metrics(&self, wr: &mut ByteBuf, metrics: &Metrics, positions: &HashMap<Rc<str>, u32>) {
        encode::write_map_len(wr, metrics.len() as u32).unwrap();

        for (k, v) in metrics {
            encode::write_uint(wr, positions[k] as u64).unwrap();
            encode::write_f64(wr, *v).unwrap();
        }
    }
}
