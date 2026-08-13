//! Hand-rolled msgpack v0.4, not `rmp-serde` / `rmpv`.
//!
//! `0.4.js` deliberately mixes fixed and runtime-chosen widths per field: the three
//! ids are always `uint64` whatever their value, the outer trace arrays are always
//! `array32` regardless of length, the meta and metrics maps are always `map32`, and
//! `error`, `start`, `duration` and metric *values* each get the shortest
//! int-or-float encoding at runtime. A generic `Serialize` derive cannot reproduce
//! that mix, which is the whole justification for writing the bytes here.
//!
//! `write_int_or_float` replicates `MsgpackChunk#writeIntOrFloat` exactly, including
//! its positive-fixint fast path and its treatment of `NaN`, `±Infinity` and `-0.0`
//! as float64 rather than collapsing them to zero. For `start` and `duration` the
//! float branch can never fire — both are integer nanosecond counts by construction
//! (see the `id.js` rewrite section of the design doc) — but the dispatch is
//! replicated anyway, since byte-for-byte fidelity is the point.

use std::rc::Rc;

/// The only endpoint this extension speaks.
///
/// The agent's indexed-string format was implemented here and then dropped: it encoded at
/// half the speed (35 ms against 17 ms per 150k spans), because a string table trades a
/// `memcpy` for a hash lookup per string and a Rust `Rc<str>` is already UTF-8, so there
/// was no conversion for the table to amortise. Worth knowing before reaching for it
/// again — the same trade favours the table in JS, which is why the JS encoder has one.
pub const AGENT_PATH: &str = "/v0.4/traces";

const ARRAY_32: u8 = 0xDD;
const UINT_32: u8 = 0xCE;
const UINT_64: u8 = 0xCF;
const INT_64: u8 = 0xD3;
const FLOAT_64: u8 = 0xCB;
const STR_32: u8 = 0xDB;

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

/// Bytes a typical HTTP server span occupies on the v0.4 wire, used to size the payload
/// buffer up front. v0.4 spells out every key and value, so it runs wide.
pub const ESTIMATED_SPAN_BYTES: usize = 260;

/// A span as the wire wants it, borrowed rather than owned.
///
/// This replaced an owned `FormattedSpan` that chunk assembly built and the encoder
/// then walked. Borrowing removes, per span: a ~100-byte struct write, two `Vec` moves,
/// three to five `Rc` clones for the name / resource / service / type, and an
/// allocation whenever one of those needed truncating — a truncation is now just a
/// shorter `&str`.
pub struct SpanWire<'a> {
    pub trace_id: u64,
    pub span_id: u64,
    pub parent_id: u64,
    pub service: &'a str,
    pub name: &'a str,
    pub resource: &'a str,
    pub span_type: &'a str,
    pub error: i64,
    pub start: u64,
    pub duration: u64,
    pub meta: &'a [(Rc<str>, Rc<str>)],
    pub metrics: &'a [(Rc<str>, f64)],
}

/// Reserve the outer `array32` header. The trace count is not known until every
/// completed segment has been written, and `array32` is fixed width, so the slot is
/// patched by `finish_payload`.
pub fn begin_payload(out: &mut Vec<u8>) {
    out.push(ARRAY_32);
    out.extend_from_slice(&[0, 0, 0, 0]);
}

/// One trace: an `array32` of spans.
pub fn write_trace_header(out: &mut Vec<u8>, span_count: u32) {
    write_array_32_prefix(out, span_count);
}

pub fn finish_payload(out: &mut [u8], trace_count: u32) {
    out[1..5].copy_from_slice(&trace_count.to_be_bytes());
}

/// Widest the fixed part of a span can be: the map header, the optional `type` key with
/// a `str32` header, the three fused id fields, the three name keys with `str32` headers,
/// the `error` / `start` / `duration` trio at `uint64`, and both map headers. Rounded up.
const FIXED_SPAN_BYTES: usize = 224;

/// A cursor over a `Vec<u8>`'s reserved-but-unwritten tail.
///
/// Every field of a span used to go through `extend_from_slice`, which re-checks capacity
/// on each of the fourteen-plus calls a span makes. Reserving the span's upper bound once
/// and writing through a cursor removes those checks from a path that runs per span.
struct Cursor {
    ptr: *mut u8,
    at: usize,
}

impl Cursor {
    /// # Safety
    /// `src.len()` must fit in the remaining reservation.
    #[inline]
    unsafe fn bytes(&mut self, src: &[u8]) {
        std::ptr::copy_nonoverlapping(src.as_ptr(), self.ptr.add(self.at), src.len());
        self.at += src.len();
    }

    /// # Safety
    /// At least one byte must remain in the reservation.
    #[inline]
    unsafe fn byte(&mut self, value: u8) {
        *self.ptr.add(self.at) = value;
        self.at += 1;
    }

}

/// Upper bound on the bytes `write_span` will write. Deduplication only ever drops map
/// entries and every width here is the widest that field can take, so this is never an
/// underestimate — which is what makes the cursor writes sound.
fn span_bound(span: &SpanWire) -> usize {
    let mut bound = FIXED_SPAN_BYTES
        + span.name.len()
        + span.resource.len()
        + span.service.len()
        + span.span_type.len();
    for (key, value) in span.meta {
        // Two `str32` headers at most, plus both payloads.
        bound += 10 + key.len() + value.len();
    }
    for (key, _) in span.metrics {
        // A `str32` header, plus the widest number encoding.
        bound += 14 + key.len();
    }
    bound
}

pub fn write_span(out: &mut Vec<u8>, span: &SpanWire) {
    let bound = span_bound(span);
    out.reserve(bound);

    // SAFETY: `reserve` guarantees `bound` writable bytes past `len`, and `span_bound`
    // over-estimates every write below. The cursor never advances past `bound`, which the
    // `debug_assert` at the end pins in test builds.
    let written = unsafe {
        let mut cursor = Cursor {
            ptr: out.as_mut_ptr().add(out.len()),
            at: 0,
        };
        write_span_into(&mut cursor, span);
        debug_assert!(cursor.at <= bound, "span exceeded its bound");
        cursor.at
    };
    // SAFETY: `written` bytes were just initialised by the cursor.
    unsafe { out.set_len(out.len() + written) };
}

/// # Safety
/// The cursor must have `span_bound(span)` bytes available.
unsafe fn write_span_into(out: &mut Cursor, span: &SpanWire) {
    let has_type = !span.span_type.is_empty();

    out.put(0x80 + V04_FIELD_COUNT + u8::from(has_type));

    // `type` leads, and is omitted entirely when absent — `0.4.js` gates on
    // `if (span.type)`, so an empty type is a missing key, not an empty string.
    if has_type {
        out.put_slice(KEY_TYPE);
        write_str(out, span.span_type);
    }

    out.put_slice(KEY_TRACE_ID_U64);
    out.put_slice(&span.trace_id.to_be_bytes());
    out.put_slice(KEY_SPAN_ID_U64);
    out.put_slice(&span.span_id.to_be_bytes());
    out.put_slice(KEY_PARENT_ID_U64);
    out.put_slice(&span.parent_id.to_be_bytes());

    out.put_slice(KEY_NAME);
    write_str(out, span.name);
    out.put_slice(KEY_RESOURCE);
    write_str(out, span.resource);
    out.put_slice(KEY_SERVICE);
    write_str(out, span.service);

    match span.error {
        0 => out.put_slice(KEY_ERROR_0),
        1 => out.put_slice(KEY_ERROR_1),
        other => {
            out.put_slice(KEY_ERROR);
            write_int_or_float(out, other as f64);
        }
    }

    out.put_slice(KEY_START);
    write_int_or_float(out, span.start as f64);
    out.put_slice(KEY_DURATION);
    write_int_or_float(out, span.duration as f64);

    write_meta(out, span.meta);
    write_metrics(out, span.metrics);
}

/// # Safety
/// The cursor must have room for every entry, per `span_bound`.
unsafe fn write_meta(out: &mut Cursor, meta: &[(Rc<str>, Rc<str>)]) {
    out.put_slice(KEY_META_MAP32);
    let count_offset = out.at;
    out.put_slice(&[0, 0, 0, 0]);

    let mut count: u32 = 0;
    for (index, (key, value)) in meta.iter().enumerate() {
        if meta[index + 1..].iter().any(|(later, _)| later == key) {
            continue;
        }
        write_str(out, key);
        write_str(out, value);
        count += 1;
    }

    std::ptr::copy_nonoverlapping(count.to_be_bytes().as_ptr(), out.ptr.add(count_offset), 4);
}

/// # Safety
/// The cursor must have room for every entry, per `span_bound`.
unsafe fn write_metrics(out: &mut Cursor, metrics: &[(Rc<str>, f64)]) {
    out.put_slice(KEY_METRICS_MAP32);
    let count_offset = out.at;
    out.put_slice(&[0, 0, 0, 0]);

    let mut count: u32 = 0;
    for (index, (key, value)) in metrics.iter().enumerate() {
        if metrics[index + 1..].iter().any(|(later, _)| later == key) {
            continue;
        }
        write_str(out, key);
        write_int_or_float(out, *value);
        count += 1;
    }

    std::ptr::copy_nonoverlapping(count.to_be_bytes().as_ptr(), out.ptr.add(count_offset), 4);
}

/// Somewhere bytes go. Two implementations: a plain `Vec<u8>` for the payload framing,
/// and `Cursor` for the per-span hot path. One trait keeps the msgpack width selection —
/// which has to stay byte-identical to `MsgpackChunk` — in a single place.
trait Sink {
    fn put(&mut self, value: u8);
    fn put_slice(&mut self, src: &[u8]);
}

impl Sink for Vec<u8> {
    #[inline]
    fn put(&mut self, value: u8) {
        self.push(value);
    }

    #[inline]
    fn put_slice(&mut self, src: &[u8]) {
        self.extend_from_slice(src);
    }
}

impl Sink for Cursor {
    #[inline]
    fn put(&mut self, value: u8) {
        // SAFETY: upheld by the caller of `write_span_into`, whose reservation covers
        // every write reachable from it. See `span_bound`.
        unsafe { self.byte(value) }
    }

    #[inline]
    fn put_slice(&mut self, src: &[u8]) {
        // SAFETY: as above.
        unsafe { self.bytes(src) }
    }
}

fn write_array_32_prefix(out: &mut Vec<u8>, length: u32) {
    out.push(ARRAY_32);
    out.extend_from_slice(&length.to_be_bytes());
}

/// A msgpack string: `fixstr` under 32 bytes, `str32` above.
fn write_str<S: Sink>(out: &mut S, value: &str) {
    let bytes = value.as_bytes();
    if bytes.len() < 0x20 {
        out.put(0xA0 | bytes.len() as u8);
    } else {
        out.put(STR_32);
        out.put_slice(&(bytes.len() as u32).to_be_bytes());
    }
    out.put_slice(bytes);
}

/// The shortest valid msgpack number encoding, replicating
/// `MsgpackChunk#writeIntOrFloat`: positive fixint fast path first, then compact
/// signed / unsigned ints for exact integers, float64 for everything else. `NaN`,
/// `±Infinity` and `-0.0` all take the float64 branch and keep their bits, which is
/// why this cannot be `writeNumber`'s logic.
// The explicit bounds mirror the JS `value === (value & 0x7F)` they replicate; a range
// `contains` reads further from the line it has to stay faithful to.
#[allow(clippy::manual_range_contains)]
fn write_int_or_float<S: Sink>(out: &mut S, value: f64) {
    // JS: `value === (value & 0x7F)` — an exact integer in 0..=127. `-0.0` passes
    // there too, since `-0 === 0`, and emits fixint 0; `value as u8` does the same.
    if value >= 0.0 && value <= 127.0 && value.fract() == 0.0 {
        out.put(value as u8);
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

    out.put(FLOAT_64);
    out.put_slice(&value.to_bits().to_be_bytes());
}

/// Test-only reach-in: `write_int_or_float` is the one piece whose byte fidelity with
/// `0.4.js` has to be pinned directly, and it is private to this module.
#[cfg(test)]
pub fn write_int_or_float_for_test(out: &mut Vec<u8>, value: f64) {
    write_int_or_float(out, value);
}

fn write_unsigned<S: Sink>(out: &mut S, value: u64) {
    if value <= 0x7F {
        out.put(value as u8);
    } else if value <= 0xFF {
        out.put(0xCC);
        out.put(value as u8);
    } else if value <= 0xFFFF {
        out.put(0xCD);
        out.put_slice(&(value as u16).to_be_bytes());
    } else if value <= 0xFFFF_FFFF {
        out.put(UINT_32);
        out.put_slice(&(value as u32).to_be_bytes());
    } else {
        out.put(UINT_64);
        out.put_slice(&value.to_be_bytes());
    }
}

fn write_signed<S: Sink>(out: &mut S, value: i64) {
    if value >= -0x20 {
        out.put(value as i8 as u8);
    } else if value >= -0x80 {
        out.put(0xD0);
        out.put(value as i8 as u8);
    } else if value >= -0x8000 {
        out.put(0xD1);
        out.put_slice(&(value as i16).to_be_bytes());
    } else if value >= -0x8000_0000 {
        out.put(0xD2);
        out.put_slice(&(value as i32).to_be_bytes());
    } else {
        out.put(INT_64);
        out.put_slice(&value.to_be_bytes());
    }
}
