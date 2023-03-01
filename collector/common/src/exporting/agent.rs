use crate::client::Client;
use crate::tracing::{Trace, Traces};
use super::Exporter;
use rmp::encode;
use rmp::encode::ByteBuf;
use hashbrown::HashMap;

pub struct AgentExporter {
    client: Box<dyn Client + Send + Sync>
}

impl Exporter for AgentExporter {
    fn export(&self, traces: Traces) {
        let mut wr = ByteBuf::new();
        let trace_count = traces.len();

        if trace_count > 0 {
            // println!("{:#?}", traces);

            self.encode_traces(&mut wr, traces);

            let data: Vec<u8> = wr.as_vec().to_vec();

            // TODO: Get the response somehow (with a channel?)
            // TODO: Make client reusable between requests (with a channel?)
            self.client.request(data);
        }
    }
}

impl AgentExporter {
    pub fn new(client: Box<dyn Client + Send + Sync>) -> Self {
        Self {
            client
        }
    }

    fn encode_traces(&self, wr: &mut ByteBuf, traces: Traces) {
        encode::write_array_len(wr, traces.len() as u32).unwrap();

        for trace in traces.values() {
            self.encode_trace(wr, trace);
        }
    }

    fn encode_trace(&self, wr: &mut ByteBuf, trace: &Trace) {
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

            self.encode_meta(wr, &span.meta);
            self.encode_metrics(wr, &span.metrics);
        }
    }

    fn encode_meta(&self, wr: &mut ByteBuf, map: &HashMap<String, String>) {
        encode::write_str(wr, "meta").unwrap();
        encode::write_map_len(wr, map.len() as u32).unwrap();

        for (k, v) in map {
            encode::write_str(wr, k.as_str()).unwrap();
            encode::write_str(wr, v.as_str()).unwrap();
        }
    }

    fn encode_metrics(&self, wr: &mut ByteBuf, map: &HashMap<String, f64>) {
        encode::write_str(wr, "metrics").unwrap();
        encode::write_map_len(wr, map.len() as u32).unwrap();

        for (k, v) in map {
            encode::write_str(wr, k.as_str()).unwrap();
            encode::write_f64(wr, *v).unwrap();
        }
    }
}
