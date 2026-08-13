//! Temporary stage-timing harness. `cargo test --release stage_timings -- --nocapture --ignored`
//!
//! Synthesizes the exact event sequence `EventWriter` produces for a root span with
//! three tags, then times decode / process / encode separately over it.

use std::rc::Rc;
use std::time::Instant;

use crate::decode::decode;
use crate::encode::{encode, Protocol};
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
}

/// One flush batch's worth of spans, shaped like the `tags` variant of
/// `benchmark/sirun/spans`: a root span, `_dd.p.tid`, the operation name, three tags
/// and `_dd.integration`, all against a freshly created context.
fn build_log() -> Log {
    build_log_with(true)
}

/// `finish: false` leaves every segment open, so `take_chunk` and `finalize` never
/// run and what is left is the event-application loop alone.
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

    for index in 0..SPANS {
        let span_id = index as u64 + 1;
        log.events.extend_from_slice(&[
            KIND_SEGMENT_START,
            0,
            span_id as u32,
            0,
            0,
            0,
            span_id as u32,
        ]);
        log.events.extend_from_slice(&[
            KIND_SPAN_START,
            0,
            span_id as u32,
            0,
            span_id as u32,
            0,
            0,
            0x18c9_5cd5,
            0xab40_0000,
        ]);
        // First tag after SPAN_START is the second touch, so it enters the context and
        // every later tag on this span is the elided form.
        log.events.push(KIND_ENTER_CONTEXT_KEEP_LAST);
        log.events
            .extend_from_slice(&[KIND_SET_TAG_STRING, tid_key, tid_value]);
        log.events.extend_from_slice(&[
            KIND_SET_TAG_STRING,
            RESERVED_STRINGS.iter().position(|v| *v == "operation.name").unwrap() as u32,
            name_value,
        ]);
        log.events.extend_from_slice(&[
            KIND_SET_TAG_STRING,
            RESERVED_STRINGS.iter().position(|v| *v == "service.name").unwrap() as u32,
            service_value,
        ]);
        log.events
            .extend_from_slice(&[KIND_SET_TAG_STRING, env_key, env_value]);
        log.events.extend_from_slice(&[
            KIND_SET_TAG_STRING,
            method_key,
            RESERVED_STRINGS.iter().position(|v| *v == "GET").unwrap() as u32,
        ]);
        log.events.extend_from_slice(&[
            KIND_SET_TAG_STRING,
            RESERVED_STRINGS.iter().position(|v| *v == "_dd.integration").unwrap() as u32,
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
        let decoded = decode(&log.events, &log.doubles, &log.strings);
        let mut assembler = Assembler::new(1000);
        let started = Instant::now();
        let chunks = assembler.process(decoded);
        println!(
            "trial {trial}: apply-only process {} us ({} chunks)",
            started.elapsed().as_micros(),
            chunks.len()
        );
    }
}

/// Prices `0.4.js`'s string cache in Rust. The JS cache stores each string's *encoded*
/// msgpack bytes so a repeat avoids V8's UTF-16 to UTF-8 conversion. A Rust `Rc<str>` is
/// already UTF-8, so the only thing left to avoid is the `memcpy` — and a hash lookup
/// has to be paid to avoid it. This measures whether that trade ever pays.
#[test]
#[ignore = "timing harness, not an assertion"]
fn v04_string_cache_comparison() {
    use std::collections::HashMap;

    let log = build_log();
    let mut assembler = Assembler::new(1000);
    let chunks = assembler.process(decode(&log.events, &log.doubles, &log.strings));

    // Plain: length prefix + copy, which is what the shipped encoder does.
    let plain = |chunks: &[crate::process::Chunk]| {
        let mut out: Vec<u8> = Vec::with_capacity(1 << 22);
        for chunk in chunks {
            for span in chunk {
                for (key, value) in &span.meta {
                    push_str(&mut out, key);
                    push_str(&mut out, value);
                }
            }
        }
        out.len()
    };

    // Cached: one map from string content to its pre-encoded bytes, the shape
    // `0.4.js`'s `_stringMap` has.
    let cached = |chunks: &[crate::process::Chunk]| {
        let mut out: Vec<u8> = Vec::with_capacity(1 << 22);
        let mut cache: HashMap<Rc<str>, Vec<u8>> = HashMap::new();
        for chunk in chunks {
            for span in chunk {
                for (key, value) in &span.meta {
                    for text in [key, value] {
                        let encoded = cache.entry(Rc::clone(text)).or_insert_with(|| {
                            let mut buffer = Vec::new();
                            push_str(&mut buffer, text);
                            buffer
                        });
                        out.extend_from_slice(encoded);
                    }
                }
            }
        }
        out.len()
    };

    for (name, run) in [
        ("plain  (prefix + memcpy)", &plain as &dyn Fn(&[crate::process::Chunk]) -> usize),
        ("cached (hash + memcpy) ", &cached),
    ] {
        run(&chunks);
        let mut times = Vec::new();
        for _ in 0..5 {
            let started = Instant::now();
            let bytes = run(&chunks);
            times.push((started.elapsed().as_micros(), bytes));
        }
        times.sort();
        println!("{name}: median {} us ({} bytes)", times[2].0, times[2].1);
    }
}

/// Same `str` emission the encoder uses, duplicated here so the comparison does not
/// depend on a private helper.
fn push_str(out: &mut Vec<u8>, value: &str) {
    let bytes = value.as_bytes();
    if bytes.len() < 0x20 {
        out.push(0xA0 | bytes.len() as u8);
    } else {
        out.push(0xDB);
        out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    }
    out.extend_from_slice(bytes);
}

#[test]
#[ignore = "timing harness, not an assertion"]
fn stage_timings() {
    let log = build_log();
    println!(
        "\n{SPANS} spans, {} words ({} KiB), {} string bytes",
        log.events.len(),
        log.events.len() * 4 / 1024,
        log.strings.len()
    );

    for trial in 0..5 {
        let started = Instant::now();
        let decoded = decode(&log.events, &log.doubles, &log.strings);
        let decode_micros = started.elapsed().as_micros();
        let event_count = decoded.len();

        let mut assembler = Assembler::new(1000);
        let started = Instant::now();
        let chunks = assembler.process(decoded);
        let process_micros = started.elapsed().as_micros();

        let started = Instant::now();
        let payload_v05 = encode(&chunks, Protocol::V05);
        let encode_v05_micros = started.elapsed().as_micros();

        let started = Instant::now();
        let payload_v04 = encode(&chunks, Protocol::V04);
        let encode_v04_micros = started.elapsed().as_micros();

        println!(
            "trial {trial}: decode {decode_micros} us, process {process_micros} us, \
             encode v0.5 {encode_v05_micros} us ({} KiB), encode v0.4 {encode_v04_micros} us ({} KiB) \
             | {event_count} events, {} chunks",
            payload_v05.len() / 1024,
            payload_v04.len() / 1024,
            chunks.len()
        );
    }
}
