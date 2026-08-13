//! Wire format shared with the JS `EventWriter`.
//!
//! Keep in sync with `../../wire.js`; `test/native-spans/wire.spec.js` parses this
//! file and pins the two against each other.

pub const KIND_SPAN_START: u32 = 1;
pub const KIND_SET_TAG_STRING: u32 = 2;
pub const KIND_SET_TAG_STRING_ID: u32 = 3;
pub const KIND_SET_TAG_NUMBER: u32 = 4;
pub const KIND_SET_TAG_NUMBER_ID: u32 = 5;
pub const KIND_ADD_LINK: u32 = 6;
pub const KIND_ADD_LINK_ID: u32 = 7;
pub const KIND_ADD_EVENT: u32 = 8;
pub const KIND_ADD_EVENT_ID: u32 = 9;
pub const KIND_FINISH: u32 = 10;
pub const KIND_FINISH_ID: u32 = 11;
pub const KIND_REGISTER_STRING: u32 = 12;
pub const KIND_PROCESS_INFO: u32 = 13;
pub const KIND_SEGMENT_START: u32 = 14;
pub const KIND_ENTER_CONTEXT_KEEP_LAST: u32 = 15;
pub const KIND_ENTER_CONTEXT_NEW: u32 = 16;
pub const KIND_WEB_REQUEST_START: u32 = 17;
pub const KIND_WEB_REQUEST_FINISH: u32 = 18;
pub const KIND_SPAN_ERROR: u32 = 19;
pub const KIND_MIDDLEWARE_START: u32 = 20;

pub const KIND_COUNT: usize = 21;

/// Record width in words, kind tag included, indexed by kind. A zero entry marks
/// an unassigned tag, which decode treats as a corrupt stream and bails on.
pub const WIDTHS: [u8; KIND_COUNT] = {
    let mut widths = [0u8; KIND_COUNT];
    widths[KIND_SPAN_START as usize] = 9;
    widths[KIND_SET_TAG_STRING as usize] = 3;
    widths[KIND_SET_TAG_STRING_ID as usize] = 5;
    widths[KIND_SET_TAG_NUMBER as usize] = 2;
    widths[KIND_SET_TAG_NUMBER_ID as usize] = 4;
    widths[KIND_ADD_LINK as usize] = 4;
    widths[KIND_ADD_LINK_ID as usize] = 6;
    widths[KIND_ADD_EVENT as usize] = 5;
    widths[KIND_ADD_EVENT_ID as usize] = 7;
    widths[KIND_FINISH as usize] = 3;
    widths[KIND_FINISH_ID as usize] = 5;
    widths[KIND_REGISTER_STRING as usize] = 3;
    widths[KIND_PROCESS_INFO as usize] = 7;
    widths[KIND_SEGMENT_START as usize] = 7;
    widths[KIND_ENTER_CONTEXT_KEEP_LAST as usize] = 1;
    widths[KIND_ENTER_CONTEXT_NEW as usize] = 3;
    widths[KIND_WEB_REQUEST_START as usize] = 11;
    widths[KIND_WEB_REQUEST_FINISH as usize] = 8;
    widths[KIND_SPAN_ERROR as usize] = 6;
    widths[KIND_MIDDLEWARE_START as usize] = 11;
    widths
};

/// Doubles drawn from the shared doubles buffer per record, indexed by kind.
/// Consumed positionally, exactly like `REGISTER_STRING`'s bytes: decode keeps one
/// cursor and advances it by this count, whatever the kind. Adding a second
/// float-carrying kind is one row here and nothing else.
pub const DOUBLE_COUNTS: [u8; KIND_COUNT] = {
    let mut counts = [0u8; KIND_COUNT];
    counts[KIND_SET_TAG_NUMBER as usize] = 1;
    counts[KIND_SET_TAG_NUMBER_ID as usize] = 1;
    counts
};

/// Strings with fixed ids on both sides. Outside the resettable id range, so they
/// never appear in a `REGISTER_STRING` record. Append only, never reorder.
pub const RESERVED_STRINGS: [&str; 50] = [
    "",
    "operation.name",
    "service.name",
    "resource.name",
    "span.type",
    "error",
    "error.message",
    "error.type",
    "error.stack",
    "language",
    "javascript",
    "span.kind",
    "component",
    "server",
    "client",
    "internal",
    "producer",
    "consumer",
    "http.method",
    "http.url",
    "http.status_code",
    "http.route",
    "http.useragent",
    "http.client_ip",
    "GET",
    "POST",
    "PUT",
    "DELETE",
    "web",
    "http",
    "express",
    "env",
    "version",
    "service",
    "process_id",
    "runtime-id",
    "_dd.p.tid",
    "_dd.p.dm",
    "_dd.integration",
    "_dd.base_service",
    "_dd.top_level",
    "_dd.measured",
    "_sampling_priority_v1",
    "opentracing",
    "events",
    // Names the web-server events resolve to rather than send. `http.route`,
    // `http.method` and the rest of that family are already reserved above.
    "web.request",
    "express.request",
    "router",
    "router.middleware",
    "express.middleware",
];

/// Framework ids carried by `WEB_REQUEST_FINISH`. The operation name, the `component`
/// tag and the `_dd.integration` tag all follow from this one word, so none of them
/// travels on the wire.
/// Sent by the JS side as the default; nothing here has to compare against it, since
/// "not express" is the only other case today.
#[allow(dead_code)]
pub const FRAMEWORK_HTTP: u32 = 0;
pub const FRAMEWORK_EXPRESS: u32 = 1;

/// Which host dispatched a middleware layer. Separate from `FRAMEWORK_*`: those name the
/// server framework, these the router.
pub const MIDDLEWARE_EXPRESS: u32 = 1;

pub const FIRST_DYNAMIC_STRING_ID: u32 = 64;

// Reserved keys that route into a top-level formatted-span field instead of the
// generic `meta` / `metrics` maps.
pub const KEY_OPERATION_NAME: &str = "operation.name";
pub const KEY_SERVICE_NAME: &str = "service.name";
pub const KEY_RESOURCE_NAME: &str = "resource.name";
pub const KEY_SPAN_TYPE: &str = "span.type";
pub const KEY_ERROR: &str = "error";
pub const KEY_ERROR_MESSAGE: &str = "error.message";
pub const KEY_ERROR_TYPE: &str = "error.type";
pub const KEY_ERROR_STACK: &str = "error.stack";
pub const KEY_HTTP_STATUS_CODE: &str = "http.status_code";
pub const KEY_SPAN_KIND: &str = "span.kind";

/// Combine two `u32` lanes into the 64-bit value they carry.
#[inline]
pub fn lanes_to_u64(hi: u32, lo: u32) -> u64 {
    ((hi as u64) << 32) | (lo as u64)
}
