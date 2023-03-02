use crate::exporting::Exporter;
use crate::msgpack::{read_array_len, read_f64, read_map_len, read_str, read_u16, read_u64, read_usize};
use crate::tracing::{Span, Trace, Traces, Meta, Metrics};
use hashbrown::{HashMap, HashSet};
use std::io::Read;
use std::rc::Rc;

pub struct Processor {
    exporter: Box<dyn Exporter + Send + Sync>,
    traces: Traces,
    strings: HashSet<Rc<str>>
}

// TODO: Decouple processing from exporting.
// TODO: Add support for more payload metadata (i.e. language).
// TODO: Custom more efficient events depending on span type.
// TODO: Store service metadata that can be used on every span like service name.
// TODO: Cache things like outgoing host/port or MySQL connection information.
// TODO: Event for adding trace tags.
// TODO: Event for adding baggage items.
// TODO: Add support for sampling.
// TODO: Support sending traces directly to Datadog.
// TODO: Optimize to minimize allocations and copies.

impl Processor {
    pub fn new(exporter: Box<dyn Exporter + Send + Sync>) -> Self {
        Self {
            exporter,
            traces: Traces::new(),
            // TODO: Figure out how to cache those properly.
            strings: HashSet::from([Rc::from("")])
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
            1 => self.process_start_web_request(strings, rd),
            2 => self.process_add_error(strings, rd),
            3 => self.process_finish_web_request(strings, rd),
            4 => self.process_start_span(strings, rd),
            5 => self.process_finish_span(strings, rd),
            6 => self.process_add_tags(strings, rd),
            7 => self.process_strings(strings, rd),
            8 => self.process_start_mysql_query(strings, rd),
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

    // TODO: Store an error object instead of tags on the span.
    fn process_add_error<R: Read>(&mut self, strings: &[Rc<str>], mut rd: R) {
        let size = read_array_len(&mut rd).unwrap();

        read_u64(&mut rd).unwrap();

        let trace_id = read_u64(&mut rd).unwrap();
        let span_id = read_u64(&mut rd).unwrap();

        if size < 4 {
            if let Some(trace) = self.traces.get_mut(&trace_id) {
                if let Some(mut span) = trace.spans.get_mut(&span_id) {
                    span.error = 1;
                }
            }
        } else {
            let name_key = self.from_str("error.name");
            let name = strings[read_usize(&mut rd).unwrap()].clone();
            let message_key = self.from_str("error.message");
            let message = strings[read_usize(&mut rd).unwrap()].clone();
            let stack_key = self.from_str("error.stack");
            let stack = strings[read_usize(&mut rd).unwrap()].clone();

            if let Some(trace) = self.traces.get_mut(&trace_id) {
                if let Some(mut span) = trace.spans.get_mut(&span_id) {
                    span.error = 1;

                    span.meta.insert(name_key, name);
                    span.meta.insert(message_key, message);
                    span.meta.insert(stack_key, stack);
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

    fn process_start_web_request<R: Read>(&mut self, strings: &[Rc<str>], mut rd: R) {
        let mut meta = HashMap::new();
        let metrics = HashMap::new();

        read_array_len(&mut rd).unwrap();

        let start = read_u64(&mut rd).unwrap();
        let trace_id = read_u64(&mut rd).unwrap();
        let span_id = read_u64(&mut rd).unwrap();
        let parent_id = read_u64(&mut rd).unwrap();
        let component = strings[read_usize(&mut rd).unwrap()].clone();
        let method = strings[read_usize(&mut rd).unwrap()].clone();
        let url = strings[read_usize(&mut rd).unwrap()].clone();
        let route = strings[read_usize(&mut rd).unwrap()].clone();

        // TODO: How to cache string concatenation?
        let name = Rc::from(format!("{component}.request"));
        let resource = Rc::from(format!("{method} {route}"));

        meta.insert(self.from_str("http.method"), method);
        meta.insert(self.from_str("http.url"), url);

        let span = Span {
            start,
            trace_id,
            span_id,
            parent_id,
            span_type: self.from_str("web"),
            name,
            resource,
            service: self.from_str("unnamed-app"),
            error: 0,
            duration: 0,
            meta,
            metrics
        };

        self.start_span(span);
    }

    fn process_start_mysql_query<R: Read>(&mut self, strings: &[Rc<str>], mut rd: R) {
        let mut meta = HashMap::new();
        let mut metrics = HashMap::new();

        read_array_len(&mut rd).unwrap();

        let start = read_u64(&mut rd).unwrap();
        let trace_id = read_u64(&mut rd).unwrap();
        let span_id = read_u64(&mut rd).unwrap();
        let parent_id = read_u64(&mut rd).unwrap();
        let sql = strings[read_usize(&mut rd).unwrap()].clone();
        let database = strings[read_usize(&mut rd).unwrap()].clone();
        let user = strings[read_usize(&mut rd).unwrap()].clone();
        let host = strings[read_usize(&mut rd).unwrap()].clone();
        let port = read_u16(&mut rd).unwrap();

        // TODO: How to cache string concatenation?
        meta.insert(self.from_str("db.type"), self.from_str("mysql"));
        meta.insert(self.from_str("db.user"), user);
        meta.insert(self.from_str("db.name"), database);
        meta.insert(self.from_str("out.host"), host);
        metrics.insert(self.from_str("out.port"), port as f64);

        let span = Span {
            start,
            trace_id,
            span_id,
            parent_id,
            span_type: self.from_str("sql"),
            name: self.from_str("mysql.query"),
            resource: sql,
            service: self.from_str("unnamed-app-mysql"),
            error: 0,
            duration: 0,
            meta,
            metrics
        };

        self.start_span(span);
    }

    fn process_finish_web_request<R: Read>(&mut self, _: &[Rc<str>], mut rd: R) {
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

    fn from_str(&mut self, s: &str) -> Rc<str> {
        match self.strings.get(s) {
            Some(s) => s.clone(),
            None => {
                let s: Rc<str> = Rc::from(s);
                self.strings.insert(s.clone());
                s
            }
        }
    }
}
