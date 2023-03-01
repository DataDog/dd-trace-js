use crate::exporting::Exporter;
use crate::msgpack::{read_array_len, read_f64, read_map_len, read_str, read_u16, read_u64, read_usize};
use crate::tracing::{Span, Trace, Traces, Meta, Metrics};
use hashbrown::{HashMap, HashSet};
use std::io::Read;
use std::rc::Rc;

pub struct Processor {
    exporter: Box<dyn Exporter>,
    traces: Traces,
    strings: HashSet<Rc<str>>
}

// TODO: Decouple processing from exporting.
// TODO: Add support for more payload metadata (i.e. language).
// TODO: Use 0.5 endpoint.
// TODO: Event for adding trace tags.
// TODO: Event for adding baggage items.
// TODO: Add support for sampling.
// TODO: Support sending traces directly to Datadog.
// TODO: Optimize to minimize allocations and copies.

impl Processor {
    pub fn new(exporter: Box<dyn Exporter>) -> Self {
        Self {
            exporter,
            traces: Traces::new(),
            strings: HashSet::from([
                Rc::from(""),
                Rc::from("error.message"),
                Rc::from("error.stack"),
                Rc::from("error.type"),
                Rc::from("http.method"),
                Rc::from("http.status_code"),
                Rc::from("http.url"),
                Rc::from("koa.request"),
                Rc::from("web"),
                Rc::from("unnamed-app")
            ])
        }
    }

    pub fn process<R: Read>(&mut self, mut rd: R) {
        read_array_len(&mut rd).unwrap();

        let string_count = read_array_len(&mut rd).unwrap();
        let mut strings: Vec<Rc<str>> = Vec::with_capacity(string_count as usize);

        for _ in 0..string_count {
            strings.push(Rc::from(read_str(&mut rd).as_str()));
        }

        let event_count = read_array_len(&mut rd).unwrap();

        for _ in 0..event_count {
            self.process_event(&mut strings, &mut rd);
        }
    }

    pub fn flush(&mut self) {
        let finished_traces: HashMap<u64, Trace> = self.traces
            .drain_filter(|_, v| v.started == v.finished)
            .collect();

        self.exporter.export(finished_traces);
    }

    fn process_event<R: Read>(&mut self, strings: &mut Vec<Rc<str>>, mut rd: R) {
        read_array_len(&mut rd).unwrap();

        let event_type = read_u64(&mut rd).unwrap();

        match event_type {
            1 => self.process_start_koa_request(strings, rd),
            2 => self.process_add_error(strings, rd),
            3 => self.process_finish_koa_request(strings, rd),
            4 => self.process_start_span(strings, rd),
            5 => self.process_finish_span(strings, rd),
            6 => self.process_add_tags(strings, rd),
            7 => self.process_strings(strings, rd),
            _ => ()
        }
    }

    fn process_strings<R: Read>(&mut self, strings: &mut Vec<Rc<str>>, mut rd: R) {
        let size = read_array_len(&mut rd).unwrap();

        strings.reserve(size as usize);

        for _ in 0..size {
            strings.push(Rc::from(read_str(&mut rd).as_str()));
        }
    }

    fn process_add_error<R: Read>(&mut self, strings: &[Rc<str>], mut rd: R) {
        let size = read_array_len(&mut rd).unwrap();

        read_u64(&mut rd).unwrap();

        let trace_id = read_u64(&mut rd).unwrap();
        let span_id = read_u64(&mut rd).unwrap();

        let message = if size >= 4 {
            strings[read_usize(&mut rd).unwrap()].clone()
        } else {
            Rc::from("")
        };
        let stack = if size >= 5 {
            strings[read_usize(&mut rd).unwrap()].clone()
        } else {
            Rc::from("")
        };
        let name = if size >= 6 {
            strings[read_usize(&mut rd).unwrap()].clone()
        } else {
            Rc::from("")
        };

        if let Some(trace) = self.traces.get_mut(&trace_id) {
            if let Some(mut span) = trace.spans.get_mut(&span_id) {
                span.error = 1;

                if !message.is_empty() {
                    span.meta.insert(Rc::from("error.message"), message);
                }

                if !stack.is_empty() {
                    span.meta.insert(Rc::from("error.stack"), stack);
                }

                if !name.is_empty() {
                    span.meta.insert(Rc::from("error.type"), name);
                }
            }
        }
    }

    fn process_add_tags<R: Read>(&mut self, strings: &[Rc<str>], mut rd: R) {
        read_array_len(&mut rd).unwrap();
        read_u64(&mut rd).unwrap();

        let trace_id = read_u64(&mut rd).unwrap();
        let span_id = read_u64(&mut rd).unwrap();
        let (meta, metrics) = self.read_tags(&mut rd, strings);

        if let Some(trace) = self.traces.get_mut(&trace_id) {
            if let Some(span) = trace.spans.get_mut(&span_id) {
                span.meta.extend(meta);
                span.metrics.extend(metrics);
            }
        }
    }

    fn process_start_span<R: Read>(&mut self, strings: &[Rc<str>], mut rd: R) {
        read_array_len(&mut rd).unwrap();

        let start = read_u64(&mut rd).unwrap();
        let trace_id = read_u64(&mut rd).unwrap();
        let span_id = read_u64(&mut rd).unwrap();
        let parent_id = read_u64(&mut rd).unwrap();
        let service = strings[read_usize(&mut rd).unwrap()].clone();
        let name = strings[read_usize(&mut rd).unwrap()].clone();
        let resource = strings[read_usize(&mut rd).unwrap()].clone();
        let (meta, metrics) = self.read_tags(&mut rd, strings);
        let span_type = strings[read_usize(&mut rd).unwrap()].clone();

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

        self.start_span(span);
    }

    fn process_finish_span<R: Read>(&mut self, strings: &[Rc<str>], mut rd: R) {
        read_array_len(&mut rd).unwrap();

        let start = read_u64(&mut rd).unwrap();
        let trace_id = read_u64(&mut rd).unwrap();
        let span_id = read_u64(&mut rd).unwrap();
        let (meta, metrics) = self.read_tags(&mut rd, strings);

        if let Some(mut trace) = self.traces.get_mut(&trace_id) {
            if let Some(mut span) = trace.spans.get_mut(&span_id) {
                trace.finished += 1;

                span.duration = start - span.start;

                span.meta.extend(meta);
                span.metrics.extend(metrics);
            }
        }
    }

    fn process_start_koa_request<R: Read>(&mut self, strings: &[Rc<str>], mut rd: R) {
        let mut meta = HashMap::new();
        let metrics = HashMap::new();

        read_array_len(&mut rd).unwrap();

        let start = read_u64(&mut rd).unwrap();
        let trace_id = read_u64(&mut rd).unwrap();
        let span_id = read_u64(&mut rd).unwrap();
        let parent_id = read_u64(&mut rd).unwrap();
        let method = strings[read_usize(&mut rd).unwrap()].clone();
        let url = strings[read_usize(&mut rd).unwrap()].clone(); // TODO: route not url

        // let resource = Rc::from(format!("{method} {url}"));
        let resource = self.from_str("");

        meta.insert(self.from_str("http.method"), method);
        meta.insert(self.from_str("http.url"), url);

        let span = Span {
            start,
            trace_id,
            span_id,
            parent_id,
            span_type: self.from_str("web"),
            name: self.from_str("koa.request"),
            resource,
            service: self.from_str("unnamed-app"),
            error: 0,
            duration: 0,
            meta,
            metrics
        };

        self.start_span(span);
    }

    fn process_finish_koa_request<R: Read>(&mut self, _: &[Rc<str>], mut rd: R) {
        read_array_len(&mut rd).unwrap();

        let start = read_u64(&mut rd).unwrap();
        let trace_id = read_u64(&mut rd).unwrap();
        let span_id = read_u64(&mut rd).unwrap();
        let status_code_key = self.from_str("http.status_code");
        let status_code = Rc::from(read_u16(&mut rd).unwrap().to_string());

        if let Some(mut trace) = self.traces.get_mut(&trace_id) {
            if let Some(mut span) = trace.spans.get_mut(&span_id) {
                trace.finished += 1;

                span.duration = start - span.start;
                span.meta.insert(status_code_key, status_code);
            }
        }
    }

    fn read_tags<R: Read>(&self, mut rd: R, strings: &[Rc<str>]) -> (Meta, Metrics){
        let mut meta = HashMap::new();
        let mut metrics = HashMap::new();

        let meta_size = read_map_len(&mut rd).unwrap();

        for _ in 0..meta_size {
            meta.insert(
                strings[read_usize(&mut rd).unwrap()].clone(),
                strings[read_usize(&mut rd).unwrap()].clone()
            );
        }

        let metrics_size = read_map_len(&mut rd).unwrap();

        for _ in 0..metrics_size {
            metrics.insert(
                strings[read_usize(&mut rd).unwrap()].clone(),
                read_f64(&mut rd).unwrap()
            );
        }

        (meta, metrics)
    }

    fn start_span(&mut self, span: Span) {
        let trace = self.traces.entry(span.trace_id).or_default();

        trace.started += 1;
        trace.spans.insert(span.span_id, span);
    }

    fn from_str(&self, s: &str) -> Rc<str> {
        self.strings.get(s).unwrap().clone()
    }
}
