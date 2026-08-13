//! A single sequential pass over the event log.
//!
//! Read a record's kind tag, look up its word count, extract its fields, advance.
//! `REGISTER_STRING` records decode into a batch-local table inline as they are
//! encountered — the wire protocol guarantees registration precedes first use, so
//! nothing later in the pass can want a string the table lacks.
//!
//! No thread pool. Per-record extraction has no cross-record dependency once the
//! offsets are known, so a `rayon` "extract" pass would parallelise cleanly — but
//! decode is called synchronously from `flush()`, so that would not hide any cost
//! from the benchmark, only add contention and jitter to a problem nothing has
//! measured yet.
//!
//! Fields are read by computed index inside the `match` on kind rather than by
//! reinterpreting `#[repr(C)]` structs out of the buffer. For plain `u32` fields at
//! compile-time-constant offsets LLVM emits the same loads either way, and indexed
//! reads keep one copy of the layout instead of a parallel set of struct
//! definitions restating it.

use std::rc::Rc;

use crate::wire::{
    lanes_to_u64, DOUBLE_COUNTS, FIRST_DYNAMIC_STRING_ID, KIND_ADD_EVENT, KIND_ADD_EVENT_ID,
    KIND_ADD_LINK, KIND_ADD_LINK_ID, KIND_COUNT, KIND_ENTER_CONTEXT_KEEP_LAST,
    KIND_ENTER_CONTEXT_NEW, KIND_FINISH, KIND_FINISH_ID, KIND_PROCESS_INFO, KIND_REGISTER_STRING,
    KIND_SEGMENT_START, KIND_SET_TAG_NUMBER, KIND_SET_TAG_NUMBER_ID, KIND_SET_TAG_STRING,
    KIND_SET_TAG_STRING_ID, KIND_SPAN_START, RESERVED_STRINGS, WIDTHS,
};

/// A decoded record. Strings are resolved to owned `Rc<str>` here, before the
/// batch's id table is discarded, so nothing downstream holds a reference to an id
/// whose meaning resets at the next flush.
pub enum Event {
    ProcessInfo {
        service: Rc<str>,
        env: Rc<str>,
        version: Rc<str>,
        language: Rc<str>,
        pid: u32,
    },
    SegmentStart {
        segment_id: u64,
        trace_id_upper: u64,
        trace_id: u64,
    },
    SpanStart {
        segment_id: u64,
        span_id: u64,
        parent_id: u64,
        start: u64,
    },
    SetTagString {
        span_id: u64,
        key: Rc<str>,
        value: Rc<str>,
    },
    SetTagNumber {
        span_id: u64,
        key: Rc<str>,
        value: f64,
    },
    AddLink {
        span_id: u64,
        /// Decoded per the wire table, but not consumed: a `_dd.span_links` entry
        /// needs the target's 128-bit *trace* id, which the record does not carry,
        /// so the JS side serializes the whole entry into `entry`. See
        /// `serializeLink` in `../../span.js`.
        #[allow(dead_code)]
        target_span_id: u64,
        entry: Rc<str>,
    },
    AddEvent {
        span_id: u64,
        name: Rc<str>,
        time: u64,
        attributes: Rc<str>,
    },
    Finish {
        span_id: u64,
        duration: u64,
    },
}

/// Batch-scoped id → string lookup. Built while decoding, discarded once the batch
/// is processed and encoded; nothing persistent, so a long-running process cannot
/// accumulate a string table.
struct StringTable {
    reserved: Vec<Rc<str>>,
    dynamic: Vec<Rc<str>>,
}

impl StringTable {
    fn new() -> Self {
        Self {
            reserved: RESERVED_STRINGS.iter().map(|value| Rc::from(*value)).collect(),
            dynamic: Vec::new(),
        }
    }

    fn get(&self, id: u32) -> Rc<str> {
        if id < FIRST_DYNAMIC_STRING_ID {
            return self
                .reserved
                .get(id as usize)
                .cloned()
                .unwrap_or_else(|| Rc::from(""));
        }
        self.dynamic
            .get((id - FIRST_DYNAMIC_STRING_ID) as usize)
            .cloned()
            .unwrap_or_else(|| Rc::from(""))
    }

    /// Registration order in the event log matches byte order in the string blob,
    /// so ids arrive densely in sequence and the slot is a plain push.
    fn register(&mut self, id: u32, value: &str) {
        let index = id.saturating_sub(FIRST_DYNAMIC_STRING_ID) as usize;
        if index == self.dynamic.len() {
            self.dynamic.push(Rc::from(value));
        } else {
            if index >= self.dynamic.len() {
                self.dynamic.resize(index + 1, Rc::from(""));
            }
            self.dynamic[index] = Rc::from(value);
        }
    }
}

pub fn decode(events: &[u32], doubles: &[f64], strings: &[u8]) -> Vec<Event> {
    let mut decoded = Vec::with_capacity(events.len() / 4);
    let mut table = StringTable::new();

    // Mirrors `EventWriter`'s elision state. `entered` is the subject an elided
    // record refers to; `last_explicit` makes `ENTER_CONTEXT_KEEP_LAST` resolvable.
    let mut entered: u64 = 0;
    let mut last_explicit: u64 = 0;

    let mut string_cursor: usize = 0;
    let mut double_cursor: usize = 0;
    let mut offset: usize = 0;

    while offset < events.len() {
        let kind = events[offset];
        let kind_index = kind as usize;
        if kind_index >= KIND_COUNT || WIDTHS[kind_index] == 0 {
            // Unknown tag: the stream's framing is lost, so there is no safe offset
            // to resume from. Everything decoded so far is still valid.
            break;
        }
        let width = WIDTHS[kind_index] as usize;
        if offset + width > events.len() {
            break;
        }

        let fields = &events[offset + 1..offset + width];
        let doubles_used = DOUBLE_COUNTS[kind_index] as usize;

        match kind {
            KIND_REGISTER_STRING => {
                let id = fields[0];
                let byte_length = fields[1] as usize;
                let end = (string_cursor + byte_length).min(strings.len());
                let bytes = &strings[string_cursor.min(strings.len())..end];
                table.register(id, std::str::from_utf8(bytes).unwrap_or(""));
                string_cursor = end;
            }
            KIND_PROCESS_INFO => {
                decoded.push(Event::ProcessInfo {
                    service: table.get(fields[0]),
                    env: table.get(fields[1]),
                    version: table.get(fields[2]),
                    language: table.get(fields[3]),
                    pid: fields[4],
                });
            }
            KIND_SEGMENT_START => {
                decoded.push(Event::SegmentStart {
                    segment_id: lanes_to_u64(fields[0], fields[1]),
                    trace_id_upper: lanes_to_u64(fields[2], fields[3]),
                    trace_id: lanes_to_u64(fields[4], fields[5]),
                });
            }
            KIND_SPAN_START => {
                let span_id = lanes_to_u64(fields[2], fields[3]);
                last_explicit = span_id;
                decoded.push(Event::SpanStart {
                    segment_id: lanes_to_u64(fields[0], fields[1]),
                    span_id,
                    parent_id: lanes_to_u64(fields[4], fields[5]),
                    start: lanes_to_u64(fields[6], fields[7]),
                });
            }
            KIND_ENTER_CONTEXT_KEEP_LAST => {
                entered = last_explicit;
            }
            KIND_ENTER_CONTEXT_NEW => {
                entered = lanes_to_u64(fields[0], fields[1]);
            }
            KIND_SET_TAG_STRING | KIND_SET_TAG_STRING_ID => {
                let (span_id, rest) = subject(kind == KIND_SET_TAG_STRING_ID, fields, entered, &mut last_explicit);
                decoded.push(Event::SetTagString {
                    span_id,
                    key: table.get(rest[0]),
                    value: table.get(rest[1]),
                });
            }
            KIND_SET_TAG_NUMBER | KIND_SET_TAG_NUMBER_ID => {
                let (span_id, rest) = subject(kind == KIND_SET_TAG_NUMBER_ID, fields, entered, &mut last_explicit);
                // The value is never in the word stream: it is drawn positionally
                // from the doubles buffer, the nth float-carrying record taking the
                // nth entry.
                let value = doubles.get(double_cursor).copied().unwrap_or(0.0);
                decoded.push(Event::SetTagNumber {
                    span_id,
                    key: table.get(rest[0]),
                    value,
                });
            }
            KIND_ADD_LINK | KIND_ADD_LINK_ID => {
                let (span_id, rest) = subject(kind == KIND_ADD_LINK_ID, fields, entered, &mut last_explicit);
                decoded.push(Event::AddLink {
                    span_id,
                    target_span_id: lanes_to_u64(rest[0], rest[1]),
                    entry: table.get(rest[2]),
                });
            }
            KIND_ADD_EVENT | KIND_ADD_EVENT_ID => {
                let (span_id, rest) = subject(kind == KIND_ADD_EVENT_ID, fields, entered, &mut last_explicit);
                decoded.push(Event::AddEvent {
                    span_id,
                    name: table.get(rest[0]),
                    time: lanes_to_u64(rest[1], rest[2]),
                    attributes: table.get(rest[3]),
                });
            }
            KIND_FINISH | KIND_FINISH_ID => {
                let (span_id, rest) = subject(kind == KIND_FINISH_ID, fields, entered, &mut last_explicit);
                decoded.push(Event::Finish {
                    span_id,
                    duration: lanes_to_u64(rest[0], rest[1]),
                });
            }
            _ => {}
        }

        double_cursor += doubles_used;
        offset += width;
    }

    decoded
}

/// Resolve a per-span record's subject and return the fields after it. The elided
/// form carries no id lanes at all — "no id present" means "whatever is entered" —
/// and elision only ever applies to the subject, never to a span-shaped *data*
/// field like `ADD_LINK`'s target.
#[inline]
fn subject<'a>(explicit: bool, fields: &'a [u32], entered: u64, last_explicit: &mut u64) -> (u64, &'a [u32]) {
    if explicit {
        let span_id = lanes_to_u64(fields[0], fields[1]);
        *last_explicit = span_id;
        (span_id, &fields[2..])
    } else {
        (entered, fields)
    }
}
