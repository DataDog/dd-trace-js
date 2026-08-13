//! Hand-rolled msgpack for both agent trace protocols, not `rmp-serde` / `rmpv`.
//!
//! `0.5.js` deliberately mixes fixed and runtime-chosen widths per field: string
//! table indices and the three ids are always forced to `uint32` / `uint64`
//! regardless of value, the outer string-table and trace arrays are always
//! `array32` regardless of length, the meta / metrics maps are always `map32`, and
//! `start`, `duration`, `error` and metric *values* each get the
//! shortest-int-or-float encoding at runtime. A generic `Serialize` derive cannot
//! reproduce that mix, which is the whole justification for writing the bytes here.
//!
//! `write_int_or_float` replicates `MsgpackChunk#writeIntOrFloat` exactly, including
//! its positive-fixint fast path and its treatment of `NaN`, `±Infinity` and `-0.0`
//! as float64 rather than collapsing them to zero. For `start` and `duration` the
//! float branch can never fire — both are integer nanosecond counts by construction
//! (see the `id.js` rewrite section of the design doc) — but the dispatch is
//! replicated anyway, since byte-for-byte fidelity is the point.

use std::collections::HashMap;
use std::rc::Rc;

use crate::process::{Chunk, FormattedSpan};

/// Which wire format the agent endpoint expects. v0.4 spells every field name out on
/// each span; v0.5 hoists all strings into a leading table and refers to them by
/// index. They are different enough that they get separate encoders sharing only the
/// number and string primitives.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Protocol {
    V04,
    V05,
}

impl Protocol {
    pub fn parse(value: &str) -> Self {
        if value == "0.4" {
            Self::V04
        } else {
            Self::V05
        }
    }

    pub fn path(self) -> &'static str {
        match self {
            Self::V04 => "/v0.4/traces",
            Self::V05 => "/v0.5/traces",
        }
    }
}

/// Encode chunks for the requested protocol.
pub fn encode(chunks: &[Chunk], protocol: Protocol) -> Vec<u8> {
    match protocol {
        Protocol::V04 => encode_v04(chunks),
        Protocol::V05 => encode_v05(chunks),
    }
}

// ---------------------------------------------------------------------------
// v0.4: `[trace, ...]`, each span a fixmap of spelled-out keys.
//
// Keys are constants including their fixstr header, and the ones always followed by a
// known type byte carry it too — `trace_id` is always `uint64`, `meta` is always
// `map32`, `error` is 0 or 1 on nearly every span. Same fusing `0.4.js` does with
// `buildKeyWithPrefix`, for the same reason: it collapses a run of small writes into
// one `extend_from_slice`.
//
// No string cache here, unlike `0.4.js`. That cache exists to avoid re-running V8's
// UTF-16 to UTF-8 conversion for a string the payload repeats; a Rust `Rc<str>` is
// already UTF-8, so emitting one is a length prefix plus a `memcpy` and there is no
// conversion left to amortise. A cache would trade that `memcpy` for a hash lookup
// (see `bench.rs::v04_string_cache_comparison` for the measurement).
// ---------------------------------------------------------------------------

const KEY_TYPE: &[u8] = b"\xa4type";
const KEY_TRACE_ID_U64: &[u8] = b"\xa8trace_id\xcf";
const KEY_SPAN_ID_U64: &[u8] = b"\xa7span_id\xcf";
const KEY_PARENT_ID_U64: &[u8] = b"\xa9parent_id\xcf";
const KEY_NAME: &[u8] = b"\xa4name";
const KEY_RESOURCE: &[u8] = b"\xa8resource";
const KEY_SERVICE: &[u8] = b"\xa7service";
const KEY_ERROR_0: &[u8] = b"\xa5error\x00";
const KEY_ERROR_1: &[u8] = b"\xa5error\x01";
const KEY_ERROR: &[u8] = b"\xa5error";
const KEY_START: &[u8] = b"\xa5start";
const KEY_DURATION: &[u8] = b"\xa8duration";
const KEY_META_MAP32: &[u8] = b"\xa4meta\xdf";
const KEY_METRICS_MAP32: &[u8] = b"\xa7metrics\xdf";

/// Eleven fields on every span, twelve when it has a type.
const V04_FIELD_COUNT: u8 = 11;

fn encode_v04(chunks: &[Chunk]) -> Vec<u8> {
    let span_count: usize = chunks.iter().map(Vec::len).sum();
    // v0.4 repeats every key and value inline, so it runs wider than v0.5's indexed
    // form — ~260 bytes for a typical HTTP span against ~140.
    let mut out: Vec<u8> = Vec::with_capacity(span_count * 260 + 1024);

    write_array_32_prefix(&mut out, chunks.len() as u32);
    for chunk in chunks {
        write_array_32_prefix(&mut out, chunk.len() as u32);
        for span in chunk {
            encode_span_v04(&mut out, span);
        }
    }

    out
}

fn encode_span_v04(out: &mut Vec<u8>, span: &FormattedSpan) {
    let has_type = !span.span_type.is_empty();

    // One growth check for the whole fixed part: the map header, three fused id
    // fields, the three names with their headers, and the error / start / duration
    // trio at their widest.
    out.reserve(
        64 + span.name.len() + span.resource.len() + span.service.len() + span.span_type.len(),
    );

    out.push(0x80 + V04_FIELD_COUNT + u8::from(has_type));

    // `type` leads, and is omitted entirely when absent — `0.4.js` gates on
    // `if (span.type)`, so an empty type is a missing key, not an empty string.
    if has_type {
        out.extend_from_slice(KEY_TYPE);
        write_str(out, &span.span_type);
    }

    out.extend_from_slice(KEY_TRACE_ID_U64);
    out.extend_from_slice(&span.trace_id.to_be_bytes());
    out.extend_from_slice(KEY_SPAN_ID_U64);
    out.extend_from_slice(&span.span_id.to_be_bytes());
    out.extend_from_slice(KEY_PARENT_ID_U64);
    out.extend_from_slice(&span.parent_id.to_be_bytes());

    out.extend_from_slice(KEY_NAME);
    write_str(out, &span.name);
    out.extend_from_slice(KEY_RESOURCE);
    write_str(out, &span.resource);
    out.extend_from_slice(KEY_SERVICE);
    write_str(out, &span.service);

    match span.error {
        0 => out.extend_from_slice(KEY_ERROR_0),
        1 => out.extend_from_slice(KEY_ERROR_1),
        other => {
            out.extend_from_slice(KEY_ERROR);
            write_int_or_float(out, other as f64);
        }
    }

    out.extend_from_slice(KEY_START);
    write_int_or_float(out, span.start as f64);
    out.extend_from_slice(KEY_DURATION);
    write_int_or_float(out, span.duration as f64);

    write_meta_v04(out, &span.meta);
    write_metrics_v04(out, &span.metrics);
}

fn write_meta_v04(out: &mut Vec<u8>, meta: &[(Rc<str>, Rc<str>)]) {
    out.extend_from_slice(KEY_META_MAP32);
    let count_offset = out.len();
    out.extend_from_slice(&[0, 0, 0, 0]);

    let mut count: u32 = 0;
    for (index, (key, value)) in meta.iter().enumerate() {
        if meta[index + 1..].iter().any(|(later, _)| later == key) {
            continue;
        }
        out.reserve(10 + key.len() + value.len());
        write_str(out, key);
        write_str(out, value);
        count += 1;
    }

    out[count_offset..count_offset + 4].copy_from_slice(&count.to_be_bytes());
}

fn write_metrics_v04(out: &mut Vec<u8>, metrics: &[(Rc<str>, f64)]) {
    out.extend_from_slice(KEY_METRICS_MAP32);
    let count_offset = out.len();
    out.extend_from_slice(&[0, 0, 0, 0]);

    let mut count: u32 = 0;
    for (index, (key, value)) in metrics.iter().enumerate() {
        if metrics[index + 1..].iter().any(|(later, _)| later == key) {
            continue;
        }
        out.reserve(14 + key.len());
        write_str(out, key);
        write_int_or_float(out, *value);
        count += 1;
    }

    out[count_offset..count_offset + 4].copy_from_slice(&count.to_be_bytes());
}

// ---------------------------------------------------------------------------
// v0.5: `[stringTable, traces]`, every string a `uint32` index into the table.
// ---------------------------------------------------------------------------

const ARRAY_OF_TWO: u8 = 0x92;
const ARRAY_OF_TWELVE: u8 = 0x9C;
const ARRAY_32: u8 = 0xDD;
const MAP_32: u8 = 0xDF;
const UINT_32: u8 = 0xCE;
const UINT_64: u8 = 0xCF;
const INT_64: u8 = 0xD3;
const FLOAT_64: u8 = 0xCB;
const STR_32: u8 = 0xDB;

/// Per-batch string table. Like the JS encoder's `_stringMap` / `_stringBytes` pair:
/// the payload is `[stringTable, traces]`, and every string in the traces half is a
/// `uint32` index into the first.
///
/// Keyed by content, like the JS encoder. A second map keyed by `Rc` pointer was tried
/// as a fast path — decode resolves each distinct string in a batch to one shared
/// `Rc<str>`, so the same string usually arrives as the same pointer — and it did win
/// 28 % in an isolated micro-benchmark. It made no measurable difference in the real
/// pipeline (~600 ms either way over 2M spans, three runs each), because real spans
/// carry enough unique strings that the extra pointer-map miss cancels the hit. Not
/// kept: this stage is dominated by writing the bytes, not by hashing them.
struct StringTable {
    by_content: HashMap<Rc<str>, u32>,
    bytes: Vec<u8>,
    count: u32,
}

impl StringTable {
    fn new() -> Self {
        let mut table = Self {
            by_content: HashMap::new(),
            bytes: Vec::new(),
            count: 0,
        };
        // `0.5.js`'s `_reset()` caches the empty string first, so index 0 is always
        // `""`. Seeding it here keeps every later index identical to the JS encoder's;
        // without it the whole table shifts by one and the payloads differ byte for
        // byte while still decoding to the same spans.
        table.intern(&Rc::from(""));
        table
    }

    fn intern(&mut self, value: &Rc<str>) -> u32 {
        if let Some(index) = self.by_content.get(value) {
            return *index;
        }
        let index = self.count;
        self.count += 1;
        self.by_content.insert(Rc::clone(value), index);
        write_str(&mut self.bytes, value);
        index
    }
}

fn encode_v05(chunks: &[Chunk]) -> Vec<u8> {
    let mut strings = StringTable::new();
    // ~140 bytes per span on the v0.5 wire for a typical HTTP span: the 12-slot head is
    // 61 bytes and each meta pair is 10. Growing from a 4 KiB start instead meant a
    // dozen reallocations and memcpys of a payload that reaches tens of megabytes.
    let span_count: usize = chunks.iter().map(Vec::len).sum();
    let mut traces: Vec<u8> = Vec::with_capacity(span_count * 140 + 1024);

    write_array_32_prefix(&mut traces, chunks.len() as u32);
    for chunk in chunks {
        write_array_32_prefix(&mut traces, chunk.len() as u32);
        for span in chunk {
            encode_span(&mut traces, &mut strings, span);
        }
    }

    let mut payload = Vec::with_capacity(1 + 5 + strings.bytes.len() + traces.len());
    payload.push(ARRAY_OF_TWO);
    write_array_32_prefix(&mut payload, strings.count);
    payload.extend_from_slice(&strings.bytes);
    payload.extend_from_slice(&traces);
    payload
}

fn encode_span(out: &mut Vec<u8>, strings: &mut StringTable, span: &FormattedSpan) {
    let service_index = strings.intern(&span.service);
    let name_index = strings.intern(&span.name);
    let resource_index = strings.intern(&span.resource);

    out.push(ARRAY_OF_TWELVE);
    write_index(out, service_index);
    write_index(out, name_index);
    write_index(out, resource_index);
    write_id(out, span.trace_id);
    write_id(out, span.span_id);
    write_id(out, span.parent_id);
    write_int_or_float(out, span.start as f64);
    write_int_or_float(out, span.duration as f64);
    write_int_or_float(out, span.error as f64);
    write_meta(out, strings, &span.meta);
    write_metrics(out, strings, &span.metrics);
    let type_index = strings.intern(&span.span_type);
    write_index(out, type_index);
}

/// Both halves of a meta entry are `uint32` indices on the v0.5 wire. Later
/// duplicates of a key are dropped so the map cannot carry a key twice — the JS
/// side reaches the same state because it accumulates into an object, where a
/// second `setTag` on the same key overwrites the first. Last write wins there, so
/// the scan runs from the back.
fn write_meta(out: &mut Vec<u8>, strings: &mut StringTable, meta: &[(Rc<str>, Rc<str>)]) {
    let header = out.len();
    out.push(MAP_32);
    out.extend_from_slice(&[0, 0, 0, 0]);

    let mut count: u32 = 0;
    for (index, (key, value)) in meta.iter().enumerate() {
        if meta[index + 1..].iter().any(|(later, _)| later == key) {
            continue;
        }
        let key_index = strings.intern(key);
        let value_index = strings.intern(value);
        write_index(out, key_index);
        write_index(out, value_index);
        count += 1;
    }

    out[header + 1..header + 5].copy_from_slice(&count.to_be_bytes());
}

fn write_metrics(out: &mut Vec<u8>, strings: &mut StringTable, metrics: &[(Rc<str>, f64)]) {
    let header = out.len();
    out.push(MAP_32);
    out.extend_from_slice(&[0, 0, 0, 0]);

    let mut count: u32 = 0;
    for (index, (key, value)) in metrics.iter().enumerate() {
        if metrics[index + 1..].iter().any(|(later, _)| later == key) {
            continue;
        }
        let key_index = strings.intern(key);
        write_index(out, key_index);
        write_int_or_float(out, *value);
        count += 1;
    }

    out[header + 1..header + 5].copy_from_slice(&count.to_be_bytes());
}

/// `[0xCE, uint32]` — always the fixed width, whatever the value, matching
/// `#writeIndexAt`.
fn write_index(out: &mut Vec<u8>, index: u32) {
    out.push(UINT_32);
    out.extend_from_slice(&index.to_be_bytes());
}

/// `[0xCF, uint64]` — the low 64 bits of an id, big-endian, matching `#writeIdAt`
/// over `Identifier#toBuffer()`.
fn write_id(out: &mut Vec<u8>, id: u64) {
    out.push(UINT_64);
    out.extend_from_slice(&id.to_be_bytes());
}

fn write_array_32_prefix(out: &mut Vec<u8>, length: u32) {
    out.push(ARRAY_32);
    out.extend_from_slice(&length.to_be_bytes());
}

fn write_str(out: &mut Vec<u8>, value: &str) {
    let bytes = value.as_bytes();
    if bytes.len() < 0x20 {
        out.push(0xA0 | bytes.len() as u8);
    } else {
        out.push(STR_32);
        out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    }
    out.extend_from_slice(bytes);
}

/// The shortest valid msgpack number encoding, replicating
/// `MsgpackChunk#writeIntOrFloat`: positive fixint fast path first, then compact
/// signed / unsigned ints for exact integers, float64 for everything else. `NaN`,
/// `±Infinity` and `-0.0` all take the float64 branch and keep their bits, which is
/// why this cannot be `writeNumber`'s logic.
fn write_int_or_float(out: &mut Vec<u8>, value: f64) {
    // JS: `value === (value & 0x7F)` — an exact integer in 0..=127. `-0.0` passes
    // there too, since `-0 === 0`, and emits fixint 0; `value as u8` does the same.
    if value >= 0.0 && value <= 127.0 && value.fract() == 0.0 {
        out.push(value as u8);
        return;
    }

    if value.fract() == 0.0 && value.is_finite() {
        if value >= 0.0 {
            if value <= u64::MAX as f64 {
                write_unsigned(out, value as u64);
                return;
            }
        } else if value >= i64::MIN as f64 {
            write_signed(out, value as i64);
            return;
        }
    }

    out.push(FLOAT_64);
    out.extend_from_slice(&value.to_bits().to_be_bytes());
}

/// Test-only reach-in: `write_int_or_float` is the one piece whose byte fidelity with
/// `0.5.js` has to be pinned directly, and it is private to this module.
#[cfg(test)]
pub fn write_int_or_float_for_test(out: &mut Vec<u8>, value: f64) {
    write_int_or_float(out, value);
}

fn write_unsigned(out: &mut Vec<u8>, value: u64) {
    if value <= 0x7F {
        out.push(value as u8);
    } else if value <= 0xFF {
        out.push(0xCC);
        out.push(value as u8);
    } else if value <= 0xFFFF {
        out.push(0xCD);
        out.extend_from_slice(&(value as u16).to_be_bytes());
    } else if value <= 0xFFFF_FFFF {
        out.push(UINT_32);
        out.extend_from_slice(&(value as u32).to_be_bytes());
    } else {
        out.push(UINT_64);
        out.extend_from_slice(&value.to_be_bytes());
    }
}

fn write_signed(out: &mut Vec<u8>, value: i64) {
    if value >= -0x20 {
        out.push(value as i8 as u8);
    } else if value >= -0x80 {
        out.push(0xD0);
        out.push(value as i8 as u8);
    } else if value >= -0x8000 {
        out.push(0xD1);
        out.extend_from_slice(&(value as i16).to_be_bytes());
    } else if value >= -0x8000_0000 {
        out.push(0xD2);
        out.extend_from_slice(&(value as i32).to_be_bytes());
    } else {
        out.push(INT_64);
        out.extend_from_slice(&value.to_be_bytes());
    }
}
