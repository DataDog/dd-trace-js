//! Stage-timing harness. Not an assertion — run it explicitly:
//!
//! ```text
//! cargo test --release -- --nocapture --ignored --test-threads=1
//! ```
//!
//! `--test-threads=1` matters: the harnesses contaminate each other's timings otherwise.
//!
//! Synthesizes the exact event sequence `EventWriter` produces for a root span with
//! three tags, then times decode and assembly over it. Assembly and encoding are one
//! pass, so encoding is priced by difference: run assembly with byte writing on and off.

use std::time::Instant;

use crate::decode::{decode, Event};
use crate::process::Assembler;
use crate::wire::*;

const SPANS: usize = 150_000;

struct Log {
    events: Vec<u32>,
    doubles: Vec<f64>,
    strings: Vec<u8>,
    next_string_id: u32,
}

impl Log {
    fn intern(&mut self, value: &str) -> u32 {
        let id = self.next_string_id;
        self.next_string_id += 1;
        self.strings.extend_from_slice(value.as_bytes());
        self.events
            .extend_from_slice(&[KIND_REGISTER_STRING, id, value.len() as u32]);
        id
    }

    fn decode(&self) -> Vec<Event> {
        decode(&self.events, &self.doubles, &self.strings)
    }
}

fn build_log() -> Log {
    build_log_with(true)
}

/// Spans per trace. One is the worst case for per-segment overhead and unlike anything
/// real: an Express request produces three to eight spans in one segment, which amortises
/// `SEGMENT_START` and the emit bookkeeping across all of them.
fn spans_per_segment() -> usize {
    std::env::var("BENCH_SPANS_PER_SEGMENT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1)
}

/// `finish: false` leaves every segment open, so emission never runs and what is left is
/// the event-application loop alone.
fn build_log_with(finish: bool) -> Log {
    let mut log = Log {
        events: Vec::new(),
        doubles: Vec::new(),
        strings: Vec::new(),
        next_string_id: FIRST_DYNAMIC_STRING_ID,
    };

    // The interning table resets per flush, not per span, so register the recurring
    // strings once — exactly what the JS writer does within one window.
    let tid_key = log.intern("_dd.p.tid");
    let tid_value = log.intern("6a7de62b00000000");
    let name_value = log.intern("some.span.name");
    let service_value = log.intern("svc");
    let env_key = log.intern("env");
    let env_value = log.intern("prod");
    let method_key = log.intern("http.method");
    let integration_value = log.intern("opentracing");

    let reserved =
        |value: &str| RESERVED_STRINGS.iter().position(|entry| *entry == value).unwrap() as u32;

    let group = spans_per_segment();
    for index in 0..SPANS {
        let span_id = index as u64 + 1;
        let segment_id = (index - index % group) as u64 + 1;
        if index % group == 0 {
            log.events.extend_from_slice(&[
                KIND_SEGMENT_START,
                0,
                segment_id as u32,
                0,
                0,
                0,
                segment_id as u32,
            ]);
        }
        log.events.extend_from_slice(&[
            KIND_SPAN_START,
            0,
            segment_id as u32,
            0,
            span_id as u32,
            0,
            if index % group == 0 { 0 } else { segment_id as u32 },
            0x18c9_5cd5,
            0xab40_0000,
        ]);
        // The first tag after `SPAN_START` is the second touch, so it enters the context
        // and every later tag on this span takes the elided form.
        log.events.push(KIND_ENTER_CONTEXT_KEEP_LAST);
        log.events
            .extend_from_slice(&[KIND_SET_TAG_STRING, tid_key, tid_value]);
        log.events
            .extend_from_slice(&[KIND_SET_TAG_STRING, reserved("operation.name"), name_value]);
        log.events
            .extend_from_slice(&[KIND_SET_TAG_STRING, reserved("service.name"), service_value]);
        log.events
            .extend_from_slice(&[KIND_SET_TAG_STRING, env_key, env_value]);
        log.events
            .extend_from_slice(&[KIND_SET_TAG_STRING, method_key, reserved("GET")]);
        log.events.extend_from_slice(&[
            KIND_SET_TAG_STRING,
            reserved("_dd.integration"),
            integration_value,
        ]);
        if finish {
            log.events.extend_from_slice(&[KIND_FINISH, 0, 500_000]);
        }
    }

    log
}

#[test]
#[ignore = "timing harness, not an assertion"]
fn apply_only_timings() {
    let log = build_log_with(false);
    for trial in 0..5 {
        let decoded = log.decode();
        let mut assembler = Assembler::new(1000);
        let started = Instant::now();
        let payload = assembler.process(decoded, true);
        println!(
            "trial {trial}: apply-only {} us ({} traces)",
            started.elapsed().as_micros(),
            payload.trace_count
        );
    }
}

#[test]
#[ignore = "timing harness, not an assertion"]
fn stage_timings() {
    let log = build_log();
    println!(
        "\n{SPANS} spans, {} per segment, {} words ({} KiB), {} string bytes",
        spans_per_segment(),
        log.events.len(),
        log.events.len() * 4 / 1024,
        log.strings.len()
    );

    let mut with = Vec::new();
    let mut without = Vec::new();
    for trial in 0..7 {
        let started = Instant::now();
        let decoded = log.decode();
        let decode_micros = started.elapsed().as_micros();
        let event_count = decoded.len();

        let mut assembler = Assembler::new(1000);
        let started = Instant::now();
        let payload = assembler.process(decoded, true);
        let with_encode_micros = started.elapsed().as_micros();

        // The same batch again with byte writing off, so the difference is the encoder.
        // Decode outside the timer: it is measured separately above.
        let mut bare = Assembler::new(1000);
        let decoded_again = log.decode();
        let started = Instant::now();
        let bare_payload = bare.process(decoded_again, false);
        let without_encode_micros = started.elapsed().as_micros();

        println!(
            "trial {trial}: decode {decode_micros} us, assemble {without_encode_micros} us, \
             assemble+encode {with_encode_micros} us | {event_count} events, {} traces, \
             {} payload KiB",
            payload.trace_count,
            payload.bytes.len() / 1024
        );
        assert_eq!(payload.trace_count, bare_payload.trace_count);
        with.push(with_encode_micros);
        without.push(without_encode_micros);
    }
    with.sort();
    without.sort();
    println!(
        "median: assemble {} us, assemble+encode {} us",
        without[without.len() / 2],
        with[with.len() / 2]
    );
}
