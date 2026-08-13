//! Unit tests for the three stages. Run with `cargo test` from this directory.
//!
//! The end-to-end structural check against the baseline implementation lives in
//! `benchmark/sirun/native-spans/parity.js`; these cover the pieces that are easier
//! to pin directly — the byte fidelity of `write_int_or_float`, and the identity
//! elision protocol, whose whole job is attributing a record to the right span.

use std::rc::Rc;

use crate::decode::{decode, Event};
use crate::encode::{self, SpanWire};
use crate::process::Assembler;
use crate::wire::*;

/// Expected bytes are the output of `MsgpackChunk#writeIntOrFloat` for the same value,
/// captured from the JS encoder rather than derived from the msgpack spec — fidelity
/// with `0.4.js` is the requirement, not fidelity with the spec.
#[test]
fn write_int_or_float_matches_the_js_encoder() {
    let cases: &[(f64, &[u8])] = &[
        (0.0, &[0x00]),
        (1.0, &[0x01]),
        (127.0, &[0x7f]),
        (128.0, &[0xcc, 0x80]),
        (255.0, &[0xcc, 0xff]),
        (256.0, &[0xcd, 0x01, 0x00]),
        (65535.0, &[0xcd, 0xff, 0xff]),
        (65536.0, &[0xce, 0x00, 0x01, 0x00, 0x00]),
        (4294967295.0, &[0xce, 0xff, 0xff, 0xff, 0xff]),
        (4294967296.0, &[0xcf, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]),
        (-1.0, &[0xff]),
        (-32.0, &[0xe0]),
        (-33.0, &[0xd0, 0xdf]),
        (-128.0, &[0xd0, 0x80]),
        (-129.0, &[0xd1, 0xff, 0x7f]),
        (1.5, &[0xcb, 0x3f, 0xf8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
        // `-0.0` reaches fixint 0 on the JS side because `-0 === (−0 & 0x7F)`.
        (-0.0, &[0x00]),
        (f64::NAN, &[0xcb, 0x7f, 0xf8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
        (f64::INFINITY, &[0xcb, 0x7f, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
        (f64::NEG_INFINITY, &[0xcb, 0xff, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
        // A present-day start time in nanoseconds.
        (1786060800000000000.0, &[0xcf, 0x18, 0xc9, 0x5c, 0xd5, 0xab, 0x40, 0x00, 0x00]),
    ];

    for (value, expected) in cases {
        let mut out = Vec::new();
        crate::encode::write_int_or_float_for_test(&mut out, *value);
        assert_eq!(&out[..], *expected, "value {value} encoded wrongly");
    }
}

/// Just enough msgpack to read back what the encoder writes. Lets the chunk-assembly
/// tests assert on the bytes the agent would receive, instead of on an intermediate
/// representation the encoder no longer builds.
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

/// A span read back off the wire.
#[derive(Debug, Default, PartialEq)]
struct WireSpan {
    trace_id: u64,
    span_id: u64,
    parent_id: u64,
    service: String,
    name: String,
    resource: String,
    span_type: Option<String>,
    error: i64,
    start: u64,
    duration: u64,
    meta: Vec<(String, String)>,
    metrics: Vec<(String, f64)>,
}

impl WireSpan {
    fn meta_value(&self, key: &str) -> Option<&str> {
        self.meta
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }

    fn metric_value(&self, key: &str) -> Option<f64> {
        self.metrics
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| *value)
    }
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, at: 0 }
    }

    fn byte(&mut self) -> u8 {
        let value = self.bytes[self.at];
        self.at += 1;
        value
    }

    fn take(&mut self, count: usize) -> &'a [u8] {
        let slice = &self.bytes[self.at..self.at + count];
        self.at += count;
        slice
    }

    fn array32(&mut self) -> usize {
        assert_eq!(self.byte(), 0xDD, "expected array32");
        u32::from_be_bytes(self.take(4).try_into().unwrap()) as usize
    }

    fn map32_len(&mut self) -> usize {
        assert_eq!(self.byte(), 0xDF, "expected map32");
        u32::from_be_bytes(self.take(4).try_into().unwrap()) as usize
    }

    fn string(&mut self) -> String {
        let marker = self.byte();
        let length = match marker {
            0xA0..=0xBF => (marker & 0x1F) as usize,
            0xDB => u32::from_be_bytes(self.take(4).try_into().unwrap()) as usize,
            other => panic!("expected a string, got {other:#x}"),
        };
        String::from_utf8(self.take(length).to_vec()).unwrap()
    }

    fn number(&mut self) -> f64 {
        let marker = self.byte();
        match marker {
            0x00..=0x7F => marker as f64,
            0xE0..=0xFF => (marker as i8) as f64,
            0xCC => self.byte() as f64,
            0xCD => u16::from_be_bytes(self.take(2).try_into().unwrap()) as f64,
            0xCE => u32::from_be_bytes(self.take(4).try_into().unwrap()) as f64,
            0xCF => u64::from_be_bytes(self.take(8).try_into().unwrap()) as f64,
            0xD0 => (self.byte() as i8) as f64,
            0xD1 => i16::from_be_bytes(self.take(2).try_into().unwrap()) as f64,
            0xD2 => i32::from_be_bytes(self.take(4).try_into().unwrap()) as f64,
            0xD3 => i64::from_be_bytes(self.take(8).try_into().unwrap()) as f64,
            0xCB => f64::from_bits(u64::from_be_bytes(self.take(8).try_into().unwrap())),
            other => panic!("expected a number, got {other:#x}"),
        }
    }

    fn span(&mut self) -> WireSpan {
        let marker = self.byte();
        assert!((0x80..=0x8F).contains(&marker), "expected a fixmap, got {marker:#x}");
        let fields = (marker & 0x0F) as usize;

        let mut span = WireSpan::default();
        for _ in 0..fields {
            let key = self.string();
            match key.as_str() {
                "type" => span.span_type = Some(self.string()),
                "trace_id" => span.trace_id = self.number() as u64,
                "span_id" => span.span_id = self.number() as u64,
                "parent_id" => span.parent_id = self.number() as u64,
                "name" => span.name = self.string(),
                "resource" => span.resource = self.string(),
                "service" => span.service = self.string(),
                "error" => span.error = self.number() as i64,
                "start" => span.start = self.number() as u64,
                "duration" => span.duration = self.number() as u64,
                "meta" => {
                    for _ in 0..self.map32_len() {
                        let name = self.string();
                        span.meta.push((name, self.string()));
                    }
                }
                "metrics" => {
                    for _ in 0..self.map32_len() {
                        let name = self.string();
                        span.metrics.push((name, self.number()));
                    }
                }
                other => panic!("unexpected span field {other}"),
            }
        }
        span
    }
}

/// Decode a whole payload into traces of spans.
fn read_payload(bytes: &[u8]) -> Vec<Vec<WireSpan>> {
    let mut reader = Reader::new(bytes);
    let traces = reader.array32();
    let mut out = Vec::with_capacity(traces);
    for _ in 0..traces {
        let spans = reader.array32();
        out.push((0..spans).map(|_| reader.span()).collect());
    }
    assert_eq!(reader.at, bytes.len(), "payload had trailing bytes");
    out
}

/// Run a batch through assembly and read back what it encoded.
fn assemble(assembler: &mut Assembler, events: Vec<Event>) -> Vec<Vec<WireSpan>> {
    let payload = assembler.process(events, true);
    let traces = read_payload(&payload.bytes);
    assert_eq!(traces.len(), payload.trace_count, "trace count disagrees with the bytes");
    traces
}

/// Build an event log the way `EventWriter` would, so decode is exercised against the
/// real framing rather than a hand-picked happy path.
struct LogBuilder {
    events: Vec<u32>,
    doubles: Vec<f64>,
    strings: Vec<u8>,
    next_string_id: u32,
}

impl LogBuilder {
    fn new() -> Self {
        Self {
            events: Vec::new(),
            doubles: Vec::new(),
            strings: Vec::new(),
            next_string_id: FIRST_DYNAMIC_STRING_ID,
        }
    }

    fn intern(&mut self, value: &str) -> u32 {
        let id = self.next_string_id;
        self.next_string_id += 1;
        self.strings.extend_from_slice(value.as_bytes());
        self.events.extend_from_slice(&[KIND_REGISTER_STRING, id, value.len() as u32]);
        id
    }

    fn segment_start(&mut self, segment_id: u64, trace_id: u64) {
        self.events.extend_from_slice(&[
            KIND_SEGMENT_START,
            (segment_id >> 32) as u32,
            segment_id as u32,
            0,
            0,
            (trace_id >> 32) as u32,
            trace_id as u32,
        ]);
    }

    fn span_start(&mut self, segment_id: u64, span_id: u64, parent_id: u64, start: u64) {
        self.events.extend_from_slice(&[
            KIND_SPAN_START,
            (segment_id >> 32) as u32,
            segment_id as u32,
            (span_id >> 32) as u32,
            span_id as u32,
            (parent_id >> 32) as u32,
            parent_id as u32,
            (start >> 32) as u32,
            start as u32,
        ]);
    }

    fn set_tag_string(&mut self, span_id: Option<u64>, key: &str, value: &str) {
        let key_id = self.intern(key);
        let value_id = self.intern(value);
        match span_id {
            Some(id) => self.events.extend_from_slice(&[
                KIND_SET_TAG_STRING_ID,
                (id >> 32) as u32,
                id as u32,
                key_id,
                value_id,
            ]),
            None => self
                .events
                .extend_from_slice(&[KIND_SET_TAG_STRING, key_id, value_id]),
        }
    }

    fn set_tag_number(&mut self, span_id: Option<u64>, key: &str, value: f64) {
        let key_id = self.intern(key);
        self.doubles.push(value);
        match span_id {
            Some(id) => self.events.extend_from_slice(&[
                KIND_SET_TAG_NUMBER_ID,
                (id >> 32) as u32,
                id as u32,
                key_id,
            ]),
            None => self.events.extend_from_slice(&[KIND_SET_TAG_NUMBER, key_id]),
        }
    }

    fn enter_keep_last(&mut self) {
        self.events.push(KIND_ENTER_CONTEXT_KEEP_LAST);
    }

    fn enter_new(&mut self, span_id: u64) {
        self.events.extend_from_slice(&[
            KIND_ENTER_CONTEXT_NEW,
            (span_id >> 32) as u32,
            span_id as u32,
        ]);
    }

    fn finish(&mut self, span_id: Option<u64>, duration: u64) {
        match span_id {
            Some(id) => self.events.extend_from_slice(&[
                KIND_FINISH_ID,
                (id >> 32) as u32,
                id as u32,
                (duration >> 32) as u32,
                duration as u32,
            ]),
            None => self.events.extend_from_slice(&[
                KIND_FINISH,
                (duration >> 32) as u32,
                duration as u32,
            ]),
        }
    }

    fn decode(&self) -> Vec<Event> {
        decode(&self.events, &self.doubles, &self.strings)
    }
}

#[test]
fn decode_resolves_registered_strings() {
    let mut log = LogBuilder::new();
    log.span_start(1, 1, 0, 100);
    log.set_tag_string(Some(1), "operation.name", "web.request");

    let events = log.decode();

    match &events[1] {
        Event::SetTagString { span_id, key, value } => {
            assert_eq!(*span_id, 1);
            assert_eq!(&**key, "operation.name");
            assert_eq!(&**value, "web.request");
        }
        _ => panic!("expected a string tag"),
    }
}

#[test]
fn decode_resolves_reserved_string_ids_without_registration() {
    // Reserved ids never appear in a `REGISTER_STRING` record at all, so a decoder
    // that only consulted the dynamic table would silently produce empty keys.
    let mut log = LogBuilder::new();
    log.span_start(1, 1, 0, 100);
    log.events.extend_from_slice(&[
        KIND_SET_TAG_STRING,
        RESERVED_STRINGS
            .iter()
            .position(|value| *value == "span.kind")
            .unwrap() as u32,
        RESERVED_STRINGS
            .iter()
            .position(|value| *value == "server")
            .unwrap() as u32,
    ]);

    let events = log.decode();

    match &events[1] {
        Event::SetTagString { key, value, .. } => {
            assert_eq!(&**key, "span.kind");
            assert_eq!(&**value, "server");
        }
        _ => panic!("expected a string tag"),
    }
}

/// The `A, A, B, A, A` case from the design doc: an unrelated span touched in the
/// middle of a repeat run. `B`'s explicit record must not disturb the entered context,
/// and the two trailing elided records must still resolve to `A`.
#[test]
fn decode_attributes_elided_records_across_an_unrelated_explicit_one() {
    let mut log = LogBuilder::new();
    log.span_start(1, 10, 0, 100);
    log.span_start(1, 20, 10, 100);

    log.set_tag_string(Some(10), "first", "a1");
    log.enter_keep_last();
    log.set_tag_string(None, "second", "a2");
    log.set_tag_string(Some(20), "third", "b1");
    log.set_tag_string(None, "fourth", "a3");
    log.set_tag_string(None, "fifth", "a4");

    let subjects: Vec<(u64, String)> = log
        .decode()
        .iter()
        .filter_map(|event| match event {
            Event::SetTagString { span_id, key, .. } => Some((*span_id, key.to_string())),
            _ => None,
        })
        .collect();

    assert_eq!(
        subjects,
        vec![
            (10, "first".to_string()),
            (10, "second".to_string()),
            (20, "third".to_string()),
            (10, "fourth".to_string()),
            (10, "fifth".to_string()),
        ]
    );
}

#[test]
fn decode_follows_enter_context_new() {
    let mut log = LogBuilder::new();
    log.span_start(1, 10, 0, 100);
    log.span_start(1, 20, 10, 100);
    log.enter_new(20);
    log.set_tag_string(None, "key", "value");

    let events = log.decode();

    match events.last().unwrap() {
        Event::SetTagString { span_id, .. } => assert_eq!(*span_id, 20),
        _ => panic!("expected a string tag"),
    }
}

/// `SPAN_START` seeds `last_explicit`, which is what makes the one-word
/// `ENTER_CONTEXT_KEEP_LAST` resolvable straight after a span starts.
#[test]
fn decode_treats_span_start_as_the_last_explicit_subject() {
    let mut log = LogBuilder::new();
    log.span_start(1, 42, 0, 100);
    log.enter_keep_last();
    log.finish(None, 500);

    match log.decode().last().unwrap() {
        Event::Finish { span_id, duration } => {
            assert_eq!(*span_id, 42);
            assert_eq!(*duration, 500);
        }
        _ => panic!("expected a finish"),
    }
}

#[test]
fn decode_consumes_doubles_positionally() {
    let mut log = LogBuilder::new();
    log.span_start(1, 1, 0, 100);
    log.set_tag_number(Some(1), "first", 1.5);
    log.set_tag_string(Some(1), "between", "unrelated");
    log.set_tag_number(Some(1), "second", -2.25);

    let values: Vec<f64> = log
        .decode()
        .iter()
        .filter_map(|event| match event {
            Event::SetTagNumber { value, .. } => Some(*value),
            _ => None,
        })
        .collect();

    assert_eq!(values, vec![1.5, -2.25]);
}

#[test]
fn decode_stops_at_an_unknown_kind_without_losing_earlier_records() {
    let mut log = LogBuilder::new();
    log.span_start(1, 1, 0, 100);
    log.events.push(9999);
    log.span_start(1, 2, 1, 100);

    assert_eq!(log.decode().len(), 1);
}

#[test]
fn decode_stops_when_a_record_runs_past_the_end() {
    let mut log = LogBuilder::new();
    log.span_start(1, 1, 0, 100);
    // A `FINISH_ID` tag with none of its fields.
    log.events.push(KIND_FINISH_ID);

    assert_eq!(log.decode().len(), 1);
}

/// Every finished span in a segment leaves together, and the segment's unfinished
/// spans stay behind — the split `SpanProcessor._erase` makes with its `active` list.
#[test]
fn process_emits_a_chunk_once_every_started_span_finished() {
    let mut log = LogBuilder::new();
    log.segment_start(10, 777);
    log.span_start(10, 10, 0, 100);
    log.span_start(10, 20, 10, 110);
    log.set_tag_string(Some(10), "operation.name", "root");
    log.set_tag_string(Some(20), "operation.name", "child");
    log.finish(Some(20), 50);

    let mut assembler = Assembler::new(1000);
    assert!(
        assemble(&mut assembler, log.decode()).is_empty(),
        "an open segment must not emit"
    );

    let mut rest = LogBuilder::new();
    rest.finish(Some(10), 200);
    let traces = assemble(&mut assembler, rest.decode());

    assert_eq!(traces.len(), 1);
    assert_eq!(traces[0].len(), 2);
    assert_eq!(traces[0][0].name, "root");
    assert_eq!(traces[0][1].name, "child");
    assert_eq!(traces[0][0].trace_id, 777);
    assert_eq!(traces[0][1].parent_id, 10);
}

#[test]
fn process_emits_early_at_the_flush_min_spans_threshold() {
    let mut log = LogBuilder::new();
    log.segment_start(10, 777);
    log.span_start(10, 10, 0, 100);
    log.span_start(10, 20, 10, 110);
    log.finish(Some(20), 50);

    // Threshold of one: the first finish alone is enough, even with the root open.
    let mut assembler = Assembler::new(1);
    let traces = assemble(&mut assembler, log.decode());

    assert_eq!(traces.len(), 1);
    assert_eq!(traces[0].len(), 1);
    assert_eq!(traces[0][0].span_id, 20);
}

#[test]
fn process_applies_process_defaults_and_derived_tags() {
    let mut log = LogBuilder::new();
    let service = log.intern("shop");
    let environment = log.intern("prod");
    let version = log.intern("1.0.0");
    let language = log.intern("javascript");
    // The process-tags blob is the sixth field; empty here, so nothing extra lands on the
    // spans this test builds.
    let process_tags = log.intern("");
    log.events.extend_from_slice(&[
        KIND_PROCESS_INFO,
        service,
        environment,
        version,
        language,
        4242,
        process_tags,
    ]);
    log.segment_start(10, 777);
    log.span_start(10, 10, 0, 100);
    log.set_tag_string(Some(10), "operation.name", "web.request");
    log.set_tag_string(Some(10), "span.kind", "server");
    log.finish(Some(10), 200);

    let mut assembler = Assembler::new(1000);
    let traces = assemble(&mut assembler, log.decode());
    let span = &traces[0][0];

    // Service falls back to the process default; resource falls back to the name.
    assert_eq!(span.service, "shop");
    assert_eq!(span.resource, "web.request");
    assert_eq!(span.meta_value("language"), Some("javascript"));
    assert_eq!(span.metric_value("process_id"), Some(4242.0));
    assert_eq!(span.metric_value("_dd.top_level"), Some(1.0));
    // `span.kind` is not "internal", so the span is measured.
    assert_eq!(span.metric_value("_dd.measured"), Some(1.0));
}

#[test]
fn process_skips_top_level_for_a_segment_rooted_on_a_remote_parent() {
    let mut log = LogBuilder::new();
    log.segment_start(10, 777);
    log.span_start(10, 10, 99, 100);
    log.finish(Some(10), 200);

    let mut assembler = Assembler::new(1000);
    let traces = assemble(&mut assembler, log.decode());

    assert_eq!(traces[0][0].metric_value("_dd.top_level"), None);
}

#[test]
fn process_routes_reserved_keys_to_top_level_fields() {
    let mut log = LogBuilder::new();
    log.segment_start(10, 777);
    log.span_start(10, 10, 0, 100);
    log.set_tag_string(Some(10), "operation.name", "web.request");
    log.set_tag_string(Some(10), "service.name", "override");
    log.set_tag_string(Some(10), "resource.name", "GET /x");
    log.set_tag_string(Some(10), "span.type", "web");
    log.set_tag_number(Some(10), "error", 1.0);
    log.set_tag_number(Some(10), "http.status_code", 404.0);
    log.finish(Some(10), 200);

    let mut assembler = Assembler::new(1000);
    let traces = assemble(&mut assembler, log.decode());
    let span = &traces[0][0];

    assert_eq!(span.name, "web.request");
    assert_eq!(span.service, "override");
    assert_eq!(span.resource, "GET /x");
    assert_eq!(span.span_type.as_deref(), Some("web"));
    assert_eq!(span.error, 1);
    // None of those reserved keys may leak into the generic maps.
    for key in ["operation.name", "service.name", "resource.name", "span.type", "error"] {
        assert_eq!(span.meta_value(key), None, "{key} leaked into meta");
        assert_eq!(span.metric_value(key), None, "{key} leaked into metrics");
    }
    // The status code is the documented exception: a number that travels as a string.
    assert_eq!(span.meta_value("http.status_code"), Some("404"));
}

#[test]
fn process_sets_error_from_the_error_meta_keys() {
    let mut log = LogBuilder::new();
    log.segment_start(10, 777);
    log.span_start(10, 10, 0, 100);
    log.set_tag_string(Some(10), "error.message", "boom");
    log.finish(Some(10), 200);

    let mut assembler = Assembler::new(1000);
    let traces = assemble(&mut assembler, log.decode());

    assert_eq!(traces[0][0].error, 1);
    assert_eq!(traces[0][0].meta_value("error.message"), Some("boom"));
}

#[test]
fn encode_writes_the_trace_arrays_and_a_span_fixmap() {
    let mut log = LogBuilder::new();
    log.segment_start(10, 777);
    log.span_start(10, 10, 0, 100);
    log.set_tag_string(Some(10), "operation.name", "web.request");
    log.finish(Some(10), 200);

    let mut assembler = Assembler::new(1000);
    let payload = assembler.process(log.decode(), true).bytes;

    // `array32` of traces, then `array32` of spans, both fixed width whatever the
    // count — `writeArrayPrefix` never shortens to fixarray.
    assert_eq!(payload[0], 0xdd);
    assert_eq!(u32::from_be_bytes([payload[1], payload[2], payload[3], payload[4]]), 1);
    assert_eq!(payload[5], 0xdd);
    assert_eq!(u32::from_be_bytes([payload[6], payload[7], payload[8], payload[9]]), 1);
    // An 11-field fixmap: this span has no type, so the optional key is absent.
    assert_eq!(payload[10], 0x8b);
    // And the name reached the wire as a spelled-out key, not a table index.
    assert!(
        payload.windows(4).any(|window| window == b"name"),
        "no `name` key in the payload"
    );
}

#[test]
fn encode_drops_a_duplicate_meta_key_keeping_the_last_write() {
    let mut log = LogBuilder::new();
    log.segment_start(10, 777);
    log.span_start(10, 10, 0, 100);
    log.set_tag_string(Some(10), "custom", "first");
    log.set_tag_string(Some(10), "custom", "second");
    log.finish(Some(10), 200);

    let mut assembler = Assembler::new(1000);
    let traces = assemble(&mut assembler, log.decode());
    let span = &traces[0][0];

    // One entry on the wire, carrying the later write — where a JS object's
    // last-write-wins also lands.
    assert_eq!(
        span.meta.iter().filter(|(key, _)| key == "custom").count(),
        1,
        "the duplicate key reached the wire twice"
    );
    assert_eq!(span.meta_value("custom"), Some("second"));
}

// ---------------------------------------------------------------------------
// Wire fidelity. The expected bytes are the output of the JS encoders for the same
// span, captured from `packages/dd-trace/src/encode/0.4.js` rather than
// derived from the msgpack spec — matching what ships is the requirement.
// ---------------------------------------------------------------------------

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Owns what a `SpanWire` borrows, so a test case can be built by a helper and still
/// outlive it.
struct OwnedSpan {
    trace_id: u64,
    span_id: u64,
    parent_id: u64,
    service: String,
    name: String,
    resource: String,
    span_type: String,
    error: i64,
    start: u64,
    duration: u64,
    meta: Vec<(Rc<str>, Rc<str>)>,
    metrics: Vec<(Rc<str>, f64)>,
}

/// Encode one span as a whole payload, the way a single-span batch would arrive.
fn encode_one(span: &OwnedSpan) -> Vec<u8> {
    let mut out = Vec::new();
    encode::begin_payload(&mut out);
    encode::write_trace_header(&mut out, 1);
    encode::write_span(
        &mut out,
        &SpanWire {
            trace_id: span.trace_id,
            span_id: span.span_id,
            parent_id: span.parent_id,
            service: &span.service,
            name: &span.name,
            resource: &span.resource,
            span_type: &span.span_type,
            error: span.error,
            start: span.start,
            duration: span.duration,
            meta: &span.meta,
            metrics: &span.metrics,
        },
    );
    encode::finish_payload(&mut out, 1);
    out
}

/// A span with a type, `error: 0`, a nanosecond `start` past 2^32, and one entry in
/// each map.
fn span_with_type() -> OwnedSpan {
    OwnedSpan {
        trace_id: 0x4d2,
        span_id: 0x162e,
        parent_id: 0,
        service: "shop".into(),
        name: "web.request".into(),
        resource: "GET /x".into(),
        span_type: "web".into(),
        error: 0,
        start: 1_786_060_800_000_000_000,
        duration: 500_000,
        meta: vec![(Rc::from("language"), Rc::from("javascript"))],
        metrics: vec![(Rc::from("process_id"), 4242.0)],
    }
}

/// No type, `error: 1`, a fixint `start`, a zero duration and both maps empty — the
/// other side of every width decision in the encoders.
fn span_without_type() -> OwnedSpan {
    OwnedSpan {
        trace_id: 0x4d2,
        span_id: 0x162e,
        parent_id: 0x162d,
        service: "s".into(),
        name: "x".into(),
        resource: "x".into(),
        span_type: String::new(),
        error: 1,
        start: 7,
        duration: 0,
        meta: Vec::new(),
        metrics: Vec::new(),
    }
}

#[test]
fn v04_matches_the_js_encoder_byte_for_byte() {
    assert_eq!(
        hex(&encode_one(&span_with_type())),
        "dd00000001dd000000018ca474797065a3776562a874726163655f6964cf00000000000004d2\
         a77370616e5f6964cf000000000000162ea9706172656e745f6964cf0000000000000000a46e\
         616d65ab7765622e72657175657374a87265736f75726365a6474554202f78a773657276696365\
         a473686f70a56572726f7200a57374617274cf18c95cd5ab400000a86475726174696f6ece0007\
         a120a46d657461df00000001a86c616e6775616765aa6a617661736372697074a76d6574726963\
         73df00000001aa70726f636573735f6964cd1092"
            .replace(['\n', ' '], "")
    );
}

#[test]
fn v04_omits_an_absent_type_and_shrinks_the_map() {
    assert_eq!(
        hex(&encode_one(&span_without_type())),
        "dd00000001dd000000018ba874726163655f6964cf00000000000004d2a77370616e5f6964cf00\
         0000000000162ea9706172656e745f6964cf000000000000162da46e616d65a178a87265736f75\
         726365a178a773657276696365a173a56572726f7201a5737461727407a86475726174696f6e00\
         a46d657461df00000000a76d657472696373df00000000"
            .replace(['\n', ' '], "")
    );
}


/// The `str32` path and the reservation bound together. Every string in the other
/// fidelity cases is a `fixstr`, so without this the wide header — and the part of
/// `span_bound` that covers it — is never exercised. Run under `cargo test` (debug) this
/// also trips the bound's `debug_assert` if the estimate is ever short.
#[test]
fn encodes_strings_past_the_fixstr_limit() {
    let long_name = "n".repeat(64);
    let long_value = "v".repeat(70_000);
    let span = OwnedSpan {
        trace_id: 1,
        span_id: 2,
        parent_id: 0,
        service: "s".repeat(40),
        name: long_name.clone(),
        resource: "r".repeat(33),
        span_type: "t".repeat(32),
        error: 0,
        start: 1,
        duration: 1,
        meta: vec![(Rc::from("k".repeat(50).as_str()), Rc::from(long_value.as_str()))],
        metrics: vec![(Rc::from("m".repeat(31).as_str()), 1.5)],
    };

    let payload = encode_one(&span);
    let traces = read_payload(&payload);
    let decoded = &traces[0][0];

    assert_eq!(decoded.name, long_name);
    assert_eq!(decoded.service.len(), 40);
    assert_eq!(decoded.resource.len(), 33);
    // 32 is the first length that needs `str32` rather than `fixstr`.
    assert_eq!(decoded.span_type.as_deref().map(str::len), Some(32));
    assert_eq!(decoded.meta_value(&"k".repeat(50)).map(str::len), Some(70_000));
    assert_eq!(decoded.metric_value(&"m".repeat(31)), Some(1.5));
}

/// A `fixstr` holds up to 31 bytes; 31 and 32 are the last accepted and first rejected
/// lengths for the short header, and the encoder has to switch exactly there.
#[test]
fn switches_to_str32_at_exactly_thirty_two_bytes() {
    for (length, expected_marker) in [(31_usize, 0xBF_u8), (32, 0xDB)] {
        let span = OwnedSpan {
            trace_id: 1,
            span_id: 2,
            parent_id: 0,
            service: "s".to_string(),
            name: "n".repeat(length),
            resource: "r".to_string(),
            span_type: String::new(),
            error: 0,
            start: 1,
            duration: 1,
            meta: Vec::new(),
            metrics: Vec::new(),
        };
        let payload = encode_one(&span);
        // The byte right after the `name` key is the string header.
        let at = payload.windows(5).position(|window| window == b"\xa4name").unwrap() + 5;
        assert_eq!(
            payload[at] & 0xE0,
            expected_marker & 0xE0,
            "length {length} took the wrong string header"
        );
        assert_eq!(read_payload(&payload)[0][0].name.len(), length);
    }
}
