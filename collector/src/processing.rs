use crate::exporting::Exporter;
use crate::msgpack::{read_array_len, read_f64, read_map_len, read_str, read_u16, read_u32, read_u64};
use crate::tracing::{Span, Trace, Traces, Meta, Metrics};
use hashbrown::HashMap;
use std::io::Read;
use std::rc::Rc;

pub struct Processor {
    exporter: Box<dyn Exporter + Send + Sync>,
    traces: Traces
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
    pub fn new(exporter: Box<dyn Exporter + Send + Sync>) -> Self {
        Self {
            exporter,
            traces: Traces::new()
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
            strings[read_u32(&mut rd).unwrap() as usize].clone()
        } else {
            Rc::from("")
        };
        let stack = if size >= 5 {
            strings[read_u32(&mut rd).unwrap() as usize].clone()
        } else {
            Rc::from("")
        };
        let name = if size >= 6 {
            strings[read_u32(&mut rd).unwrap() as usize].clone()
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
        let size = read_array_len(&mut rd).unwrap();
        let start = read_u64(&mut rd).unwrap();
        let trace_id = read_u64(&mut rd).unwrap();
        let span_id = read_u64(&mut rd).unwrap();
        let parent_id = read_u64(&mut rd).unwrap();
        let service = strings[read_u32(&mut rd).unwrap() as usize].clone();
        let name = strings[read_u32(&mut rd).unwrap() as usize].clone();
        let resource = strings[read_u32(&mut rd).unwrap() as usize].clone();
        let (meta, metrics) = self.read_tags(&mut rd, strings);
        let span_type: Rc<str> = if size >= 10 {
            strings[read_u32(&mut rd).unwrap() as usize].clone()
        } else {
            Rc::from("")
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
        let method = strings[read_u32(&mut rd).unwrap() as usize].clone();
        let url = strings[read_u32(&mut rd).unwrap() as usize].clone(); // TODO: route not url

        let resource = Rc::from(format!("{method} {url}"));

        meta.insert(Rc::from("http.method"), method);
        meta.insert(Rc::from("http.url"), url);

        let span = Span {
            start,
            trace_id,
            span_id,
            parent_id,
            span_type: Rc::from("web"),
            name: Rc::from("koa.request"),
            resource,
            service: Rc::from("unnamed-app"),
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
        let status_code = Rc::from(read_u16(&mut rd).unwrap().to_string());

        if let Some(mut trace) = self.traces.get_mut(&trace_id) {
            if let Some(mut span) = trace.spans.get_mut(&span_id) {
                trace.finished += 1;

                span.duration = start - span.start;
                span.meta.insert(Rc::from("http.status_code"), status_code);
            }
        }
    }

    fn read_tags<R: Read>(&self, mut rd: R, strings: &[Rc<str>]) -> (Meta, Metrics){
        let mut meta = HashMap::new();
        let mut metrics = HashMap::new();

        let meta_size = read_map_len(&mut rd).unwrap();

        for _ in 0..meta_size {
            meta.insert(
                strings[read_u32(&mut rd).unwrap() as usize].clone(),
                strings[read_u32(&mut rd).unwrap() as usize].clone()
            );
        }

        let metrics_size = read_map_len(&mut rd).unwrap();

        for _ in 0..metrics_size {
            metrics.insert(
                strings[read_u32(&mut rd).unwrap() as usize].clone(),
                read_f64(&mut rd).unwrap()
            );
        }

        (meta, metrics)
    }

    fn start_span(&mut self, span: Span) {
        let trace = self.traces.entry(span.trace_id).or_insert(Trace {
            started: 0,
            finished: 0,
            spans: HashMap::new()
        });

        trace.started += 1;
        trace.spans.insert(span.span_id, span);
    }
}
