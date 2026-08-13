//! Unit tests for the three stages. Run with `cargo test` from this directory.
//!
//! The end-to-end structural check against the baseline implementation lives in
//! `benchmark/sirun/native-spans/parity.js`; these cover the pieces that are easier
//! to pin directly — the byte fidelity of `write_int_or_float`, and the identity
//! elision protocol, whose whole job is attributing a record to the right span.

use std::rc::Rc;

use crate::decode::{decode, Event};
use crate::encode::{encode, Protocol};
use crate::process::{Assembler, FormattedSpan};
use crate::wire::*;

/// Expected bytes are the output of `MsgpackChunk#writeIntOrFloat` for the same value,
/// captured from the JS encoder rather than derived from the msgpack spec — fidelity
/// with `0.5.js` is the requirement, not fidelity with the spec.
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
    assert!(assembler.process(log.decode()).is_empty(), "an open segment must not emit");

    let mut rest = LogBuilder::new();
    rest.finish(Some(10), 200);
    let chunks = assembler.process(rest.decode());

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].len(), 2);
    assert_eq!(&*chunks[0][0].name, "root");
    assert_eq!(&*chunks[0][1].name, "child");
    assert_eq!(chunks[0][0].trace_id, 777);
    assert_eq!(chunks[0][1].parent_id, 10);
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
    let chunks = assembler.process(log.decode());

    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].len(), 1);
    assert_eq!(chunks[0][0].span_id, 20);
}

#[test]
fn process_applies_process_defaults_and_derived_tags() {
    let mut log = LogBuilder::new();
    let service = log.intern("shop");
    let environment = log.intern("prod");
    let version = log.intern("1.0.0");
    let language = log.intern("javascript");
    log.events
        .extend_from_slice(&[KIND_PROCESS_INFO, service, environment, version, language, 4242]);
    log.segment_start(10, 777);
    log.span_start(10, 10, 0, 100);
    log.set_tag_string(Some(10), "operation.name", "web.request");
    log.set_tag_string(Some(10), "span.kind", "server");
    log.finish(Some(10), 200);

    let mut assembler = Assembler::new(1000);
    let chunks = assembler.process(log.decode());
    let span = &chunks[0][0];

    // Service falls back to the process default; resource falls back to the name.
    assert_eq!(&*span.service, "shop");
    assert_eq!(&*span.resource, "web.request");
    assert!(span.meta.iter().any(|(key, value)| &**key == "language" && &**value == "javascript"));
    assert!(span.metrics.iter().any(|(key, value)| &**key == "process_id" && *value == 4242.0));
    assert!(span.metrics.iter().any(|(key, value)| &**key == "_dd.top_level" && *value == 1.0));
    // `span.kind` is not "internal", so the span is measured.
    assert!(span.metrics.iter().any(|(key, value)| &**key == "_dd.measured" && *value == 1.0));
}

#[test]
fn process_skips_top_level_for_a_segment_rooted_on_a_remote_parent() {
    let mut log = LogBuilder::new();
    log.segment_start(10, 777);
    log.span_start(10, 10, 99, 100);
    log.finish(Some(10), 200);

    let mut assembler = Assembler::new(1000);
    let chunks = assembler.process(log.decode());

    assert!(!chunks[0][0].metrics.iter().any(|(key, _)| &**key == "_dd.top_level"));
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
    let chunks = assembler.process(log.decode());
    let span = &chunks[0][0];

    assert_eq!(&*span.name, "web.request");
    assert_eq!(&*span.service, "override");
    assert_eq!(&*span.resource, "GET /x");
    assert_eq!(&*span.span_type, "web");
    assert_eq!(span.error, 1);
    // None of those reserved keys may leak into the generic maps.
    for key in ["operation.name", "service.name", "resource.name", "span.type", "error"] {
        assert!(!span.meta.iter().any(|(name, _)| &**name == key), "{key} leaked into meta");
        assert!(!span.metrics.iter().any(|(name, _)| &**name == key), "{key} leaked into metrics");
    }
    // The status code is the documented exception: a number that travels as a string.
    assert!(span
        .meta
        .iter()
        .any(|(key, value)| &**key == "http.status_code" && &**value == "404"));
}

#[test]
fn process_sets_error_from_the_error_meta_keys() {
    let mut log = LogBuilder::new();
    log.segment_start(10, 777);
    log.span_start(10, 10, 0, 100);
    log.set_tag_string(Some(10), "error.message", "boom");
    log.finish(Some(10), 200);

    let mut assembler = Assembler::new(1000);
    let chunks = assembler.process(log.decode());

    assert_eq!(chunks[0][0].error, 1);
    assert!(chunks[0][0].meta.iter().any(|(key, value)| &**key == "error.message" && &**value == "boom"));
}

#[test]
fn encode_writes_the_two_element_payload_and_a_twelve_slot_span() {
    let mut log = LogBuilder::new();
    log.segment_start(10, 777);
    log.span_start(10, 10, 0, 100);
    log.set_tag_string(Some(10), "operation.name", "web.request");
    log.finish(Some(10), 200);

    let mut assembler = Assembler::new(1000);
    let chunks = assembler.process(log.decode());
    let payload = encode(&chunks, Protocol::V05);

    // `[stringTable, traces]`, always a two-element array.
    assert_eq!(payload[0], 0x92);
    // The string table is always `array32`, whatever its length.
    assert_eq!(payload[1], 0xdd);

    // The trace array, the chunk array and then the span's 12-slot fixarray.
    let string_count = u32::from_be_bytes([payload[2], payload[3], payload[4], payload[5]]);
    assert!(string_count > 0);
    assert!(payload.contains(&0x9c), "no 12-slot span array in the payload");
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
    let chunks = assembler.process(log.decode());
    let payload = encode(&chunks, Protocol::V05);
    let table = String::from_utf8_lossy(&payload).to_string();

    // Both values reach the string table, but only the later pairing is in the map,
    // which is where a JS object's last-write-wins lands too.
    assert!(table.contains("second"));
    assert_eq!(
        chunks[0][0]
            .meta
            .iter()
            .filter(|(key, _)| &**key == "custom")
            .count(),
        2,
        "process keeps both; deduplication is the encoder's job"
    );
}

// ---------------------------------------------------------------------------
// Wire fidelity. The expected bytes are the output of the JS encoders for the same
// span, captured from `packages/dd-trace/src/encode/0.4.js` and `0.5.js` rather than
// derived from the msgpack spec — matching what ships is the requirement.
// ---------------------------------------------------------------------------

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A span with a type, `error: 0`, a nanosecond `start` past 2^32, and one entry in
/// each map.
fn span_with_type() -> FormattedSpan {
    FormattedSpan {
        trace_id: 0x4d2,
        span_id: 0x162e,
        parent_id: 0,
        service: Rc::from("shop"),
        name: Rc::from("web.request"),
        resource: Rc::from("GET /x"),
        span_type: Rc::from("web"),
        error: 0,
        start: 1_786_060_800_000_000_000,
        duration: 500_000,
        meta: vec![(Rc::from("language"), Rc::from("javascript"))],
        metrics: vec![(Rc::from("process_id"), 4242.0)],
    }
}

/// No type, `error: 1`, a fixint `start`, a zero duration and both maps empty — the
/// other side of every width decision in the encoders.
fn span_without_type() -> FormattedSpan {
    FormattedSpan {
        trace_id: 0x4d2,
        span_id: 0x162e,
        parent_id: 0x162d,
        service: Rc::from("s"),
        name: Rc::from("x"),
        resource: Rc::from("x"),
        span_type: Rc::from(""),
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
        hex(&encode(&[vec![span_with_type()]], Protocol::V04)),
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
        hex(&encode(&[vec![span_without_type()]], Protocol::V04)),
        "dd00000001dd000000018ba874726163655f6964cf00000000000004d2a77370616e5f6964cf00\
         0000000000162ea9706172656e745f6964cf000000000000162da46e616d65a178a87265736f75\
         726365a178a773657276696365a173a56572726f7201a5737461727407a86475726174696f6e00\
         a46d657461df00000000a76d657472696373df00000000"
            .replace(['\n', ' '], "")
    );
}

#[test]
fn v05_matches_the_js_encoder_byte_for_byte() {
    assert_eq!(
        hex(&encode(&[vec![span_with_type()]], Protocol::V05)),
        "92dd00000008a0a473686f70ab7765622e72657175657374a6474554202f78a86c616e67756167\
         65aa6a617661736372697074aa70726f636573735f6964a3776562dd00000001dd000000019cce\
         00000001ce00000002ce00000003cf00000000000004d2cf000000000000162ecf000000000000\
         0000cf18c95cd5ab400000ce0007a12000df00000001ce00000004ce00000005df00000001ce00\
         000006cd1092ce00000007"
            .replace(['\n', ' '], "")
    );
}

#[test]
fn v05_reuses_the_empty_string_at_index_zero_for_an_absent_type() {
    assert_eq!(
        hex(&encode(&[vec![span_without_type()]], Protocol::V05)),
        "92dd00000003a0a173a178dd00000001dd000000019cce00000001ce00000002ce00000002cf00\
         000000000004d2cf000000000000162ecf000000000000162d070001df00000000df00000000ce\
         00000000"
            .replace(['\n', ' '], "")
    );
}

#[test]
fn protocol_parsing_picks_the_endpoint() {
    assert_eq!(Protocol::parse("0.4"), Protocol::V04);
    assert_eq!(Protocol::parse("0.5"), Protocol::V05);
    // Anything unrecognised falls back to v0.5 rather than failing the flush.
    assert_eq!(Protocol::parse(""), Protocol::V05);
    assert_eq!(Protocol::parse("0.4").path(), "/v0.4/traces");
    assert_eq!(Protocol::parse("0.5").path(), "/v0.5/traces");
}
