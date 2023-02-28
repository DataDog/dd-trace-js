use crate::exporting::Exporter;
use crate::msgpack::{
    read_array_len, read_f64, read_map_len, read_str, read_u16, read_u32, read_u64,
};
use crate::tracing::{Span, Trace, Traces};
use hashbrown::HashMap;
use hyper::body::Bytes;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::rc::Rc;

pub struct Processor {
    exporter: Box<dyn Exporter + Send + Sync>,
    traces: Traces,
}
#[derive(serde::Deserialize, serde::Serialize)]
struct StartSpanData {
    start: u64,
    trace_id: u64,
    span_id: u64,
    parent_id: u64,
    meta: Vec<(u32, u32)>,
    metrics: Vec<(u32, u32)>,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct FinishSpanData {
    time: u64,
    trace_id: u64,
}

#[derive(serde::Deserialize, serde::Serialize)]
enum Event {
    StartSpan(StartSpanData),
    FinishSpan(StartSpanData),
}

#[derive(serde::Deserialize, serde::Serialize)]
struct EventsIntermediate<'a> {
    #[serde(borrow)]
    strings: Vec<&'a str>,
    events: Vec<Event>,
}

struct Holder {
    strings: Vec<(u32, u32)>,
    data: Bytes,
}

impl Holder {
    fn get_str<'a>(&'a self, pos: usize) -> &'a str {
        let (pos, len) = self.strings[pos];
        let pos = pos as usize;
        let len = len as usize;
        let data = self.data.as_ref();

        let s = &data[pos..pos + len];
        // the utf should've been checked during processing already
        unsafe { std::str::from_utf8_unchecked(s) }
    }
}

struct EventHolder {
    event: Event,
    data: Rc<Box<Holder>>,
}

fn parser_example(data: Bytes) -> Vec<EventHolder> {
    let intermediate: EventsIntermediate = rmp_serde::from_slice(data.as_ref()).unwrap();
    let ptr_range = data.as_ptr_range();
    let strings = intermediate
        .strings
        .iter()
        .map(|s| {
            let len = s.len() as u32;
            if !ptr_range.contains(&(*s).as_ptr()) {
                panic!("error");
            }
            let offset = unsafe { data.as_ptr().offset_from((*s).as_ptr()) }.unsigned_abs() as u32;
            (offset, len)
        })
        .collect();
    let events = intermediate.events;

    let data = Rc::new(Box::new(Holder { strings, data }));
    events
        .into_iter()
        .map(|event| EventHolder {
            event,
            data: data.clone(),
        })
        .collect()
}

impl Event {
    fn get_key(&self) -> u64 {
        match self {
            Event::StartSpan(s) => s.trace_id,
            Event::FinishSpan(s) => s.trace_id,
        }
    }
}

#[derive(Debug)]
struct ZeroStrCopySpan<'a> {
    start: u64,
    trace_id: u64,
    span_id: u64,
    parent_id: u64,
    meta: HashMap<&'a str, &'a str>,
}

impl<'a> Default for ZeroStrCopySpan<'a> {
    fn default() -> Self {
        Self {
            start: Default::default(),
            trace_id: Default::default(),
            span_id: Default::default(),
            parent_id: Default::default(),
            meta: Default::default(),
        }
    }
}

#[test]
fn test_validate_the_idea() {
    let src = EventsIntermediate {
        strings: vec!["key_a", "key_b", "val_a", "val_b"],
        events: vec![Event::StartSpan(StartSpanData {
            start: 10,
            trace_id: 11,
            span_id: 12,
            parent_id: 13,
            meta: vec![(0, 2), (1, 3)],
            metrics: vec![(0, 3)],
        })],
    };

    let bytes = rmp_serde::to_vec(&src).unwrap();
    let zero_copy_validator = bytes.as_ptr_range();

    let data = parser_example(bytes.into());

    let mut in_flight: HashMap<u64, Vec<EventHolder>> = HashMap::new();
    let mut to_flush: Vec<u64> = vec![];

    for eh in data {
        let key = eh.event.get_key();
        if let Event::FinishSpan(_) = eh.event {
            to_flush.push(key)
        }

        match in_flight.get_mut(&key) {
            Some(d) => d.push(eh),
            None => {
                let entry = vec![eh];
                in_flight.insert(key, entry);
            }
        }
    }

    // example what would happen on flush
    let events = in_flight.remove(&11).unwrap();
    let mut span = ZeroStrCopySpan::default();

    for eh in &events {
        match &eh.event {
            Event::StartSpan(s) => {
                span.parent_id = s.parent_id;
                span.trace_id = s.trace_id;
                span.span_id = s.span_id;
                for (k, v) in &s.meta {
                    let key = eh.data.get_str(*k as usize);
                    let value = eh.data.get_str(*v as usize);
                    span.meta.insert(key, value);
                }
            }
            Event::FinishSpan(_) => todo!(),
        }
    }
    // tada - no strings were copied in the making of this video

    for (k,v) in &span.meta {
        assert!(zero_copy_validator.contains(&(*k).as_ptr()));
        assert!(zero_copy_validator.contains(&(*v).as_ptr()));
    }

    assert_eq!("ZeroStrCopySpan { start: 0, trace_id: 11, span_id: 12, parent_id: 13, meta: {\"key_a\": \"val_a\", \"key_b\": \"val_b\"} }", format!("{:?}", span));
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
            traces: Traces::new(),
        }
    }

    pub fn process<R: Read>(&mut self, mut rd: R) {
        read_array_len(&mut rd).unwrap();

        let string_count = read_array_len(&mut rd).unwrap();
        let mut strings: Vec<String> = Vec::with_capacity(string_count as usize);

        for _ in 0..string_count {
            strings.push(read_str(&mut rd));
        }

        let event_count = read_array_len(&mut rd).unwrap();

        for _ in 0..event_count {
            self.process_event(&mut strings, &mut rd);
        }
    }

    pub async fn flush(&mut self) {
        let finished_traces: HashMap<u64, Trace> = self
            .traces
            .drain_filter(|_, v| v.started == v.finished)
            .collect();

        self.exporter.export(finished_traces).await;
    }

    fn process_event<R: Read>(&mut self, strings: &mut Vec<String>, mut rd: R) {
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
            _ => (),
        }
    }

    fn process_strings<R: Read>(&mut self, strings: &mut Vec<String>, mut rd: R) {
        let size = read_array_len(&mut rd).unwrap();

        strings.reserve(size as usize);

        for _ in 0..size {
            strings.push(read_str(&mut rd));
        }
    }

    fn process_add_error<R: Read>(&mut self, strings: &[String], mut rd: R) {
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

        if let Some(trace) = self.traces.get_mut(&trace_id) {
            if let Some(mut span) = trace.spans.get_mut(&span_id) {
                span.error = 1;

                if !message.is_empty() {
                    span.meta
                        .insert(String::from("error.message"), String::from(message));
                }

                if !stack.is_empty() {
                    span.meta
                        .insert(String::from("error.stack"), String::from(stack));
                }

                if !name.is_empty() {
                    span.meta
                        .insert(String::from("error.type"), String::from(name));
                }
            }
        }
    }

    fn process_add_tags<R: Read>(&mut self, strings: &[String], mut rd: R) {
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

    fn process_start_span<R: Read>(&mut self, strings: &[String], mut rd: R) {
        let size = read_array_len(&mut rd).unwrap();
        let start = read_u64(&mut rd).unwrap();
        let trace_id = read_u64(&mut rd).unwrap();
        let span_id = read_u64(&mut rd).unwrap();
        let parent_id = read_u64(&mut rd).unwrap();
        let service = strings[read_u32(&mut rd).unwrap() as usize].to_owned();
        let name = strings[read_u32(&mut rd).unwrap() as usize].to_owned();
        let resource = strings[read_u32(&mut rd).unwrap() as usize].to_owned();
        let (meta, metrics) = self.read_tags(&mut rd, strings);
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
            metrics,
        };

        self.start_span(span);
    }

    fn process_finish_span<R: Read>(&mut self, strings: &[String], mut rd: R) {
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

    fn process_start_koa_request<R: Read>(&mut self, strings: &[String], mut rd: R) {
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
            metrics,
        };

        self.start_span(span);
    }

    fn process_finish_koa_request<R: Read>(&mut self, _: &[String], mut rd: R) {
        read_array_len(&mut rd).unwrap();

        let start = read_u64(&mut rd).unwrap();
        let trace_id = read_u64(&mut rd).unwrap();
        let span_id = read_u64(&mut rd).unwrap();
        let status_code = read_u16(&mut rd).unwrap().to_string();

        if let Some(mut trace) = self.traces.get_mut(&trace_id) {
            if let Some(mut span) = trace.spans.get_mut(&span_id) {
                trace.finished += 1;

                span.duration = start - span.start;
                span.meta
                    .insert(String::from("http.status_code"), status_code);
            }
        }
    }

    fn read_tags<R: Read>(
        &self,
        mut rd: R,
        strings: &[String],
    ) -> (HashMap<String, String>, HashMap<String, f64>) {
        let mut meta = HashMap::new();
        let mut metrics = HashMap::new();

        let meta_size = read_map_len(&mut rd).unwrap();

        for _ in 0..meta_size {
            meta.insert(
                strings[read_u32(&mut rd).unwrap() as usize].to_owned(),
                strings[read_u32(&mut rd).unwrap() as usize].to_owned(),
            );
        }

        let metrics_size = read_map_len(&mut rd).unwrap();

        for _ in 0..metrics_size {
            metrics.insert(
                strings[read_u32(&mut rd).unwrap() as usize].to_owned(),
                read_f64(&mut rd).unwrap(),
            );
        }

        (meta, metrics)
    }

    fn start_span(&mut self, span: Span) {
        let trace = self.traces.entry(span.trace_id).or_insert(Trace {
            started: 0,
            finished: 0,
            spans: HashMap::new(),
        });

        trace.started += 1;
        trace.spans.insert(span.span_id, span);
    }
}
