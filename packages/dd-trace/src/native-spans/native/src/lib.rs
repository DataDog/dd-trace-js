//! Native span pipeline: decode → chunk assembly → v0.5 encode, all inline on the
//! calling thread, then an off-thread HTTP PUT.
//!
//! Everything up to and including encode runs synchronously inside `flush()`, so
//! its cost is real, attributed time in every benchmark that calls it. That matches
//! what ships today — `Writer.flush()` already runs `_encoder.makePayload()`
//! synchronously on the JS thread and defers only the request — so backgrounding
//! those stages would compare the new path against an easier bar than the baseline
//! actually faces.
//!
//! Safety invariant for the borrowed views: JS is single-threaded and blocked for
//! the whole call, so there is never a concurrent writer, and decode / process /
//! encode all run to completion before `flush()` returns. That is why they can read
//! the JS-owned buffers directly instead of copying them first — only the much
//! smaller encoded payload becomes an owned `Vec<u8>`, for the one thing that
//! genuinely outlives the call. It also requires the buffers to be plain fixed-size
//! `ArrayBuffer`s (a resizable one can move its backing pointer on `.resize()`) and
//! requires the tracer never to write to them from a Worker thread.

use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi::{Env, Task};
use napi_derive::napi;

#[cfg(test)]
mod bench;
mod agent;
mod decode;
mod encode;
mod process;
#[cfg(test)]
mod tests;
mod wire;

#[napi(object)]
pub struct FlusherOptions {
    pub url: String,
    pub tracer_version: String,
    pub node_version: String,
    /// `"0.4"` or `"0.5"`; anything else is treated as v0.5. Mirrors
    /// `DD_TRACE_AGENT_PROTOCOL_VERSION`, so the native path speaks whichever wire
    /// format the rest of the tracer was configured for.
    pub protocol_version: String,
    pub flush_min_spans: u32,
}

/// Per-stage kill switches, read once at construction. Each lets a stage be skipped
/// entirely while isolating where time goes during development. All four default on,
/// and the headline old-vs-new comparison always runs with all four on.
struct Layers {
    decode: bool,
    process: bool,
    encode: bool,
    flush: bool,
}

impl Layers {
    fn from_env() -> Self {
        Self {
            decode: enabled("DD_NATIVE_SPANS_DECODE"),
            process: enabled("DD_NATIVE_SPANS_PROCESS"),
            encode: enabled("DD_NATIVE_SPANS_ENCODE"),
            flush: enabled("DD_NATIVE_SPANS_FLUSH"),
        }
    }
}

fn enabled(name: &str) -> bool {
    match std::env::var(name) {
        Ok(value) => value != "0" && value != "false",
        Err(_) => true,
    }
}

#[napi]
pub struct EventFlusher {
    /// The three buffers, as typed views. The design doc hands all three over as
    /// `Uint8Array` with byte lengths; using the natural element type instead drops
    /// per-word byte reassembly from the decode hot path and removes any endianness
    /// assumption, since both sides see the same native-endian elements.
    events_view: Uint32Array,
    doubles_view: Float64Array,
    strings_view: Uint8Array,
    assembler: process::Assembler,
    client: Arc<agent::AgentClient>,
    protocol: encode::Protocol,
    layers: Layers,
}

#[napi]
impl EventFlusher {
    #[napi(constructor)]
    pub fn new(
        events_view: Uint32Array,
        doubles_view: Float64Array,
        strings_view: Uint8Array,
        options: FlusherOptions,
    ) -> Self {
        let protocol = encode::Protocol::parse(&options.protocol_version);
        Self {
            events_view,
            doubles_view,
            strings_view,
            assembler: process::Assembler::new(options.flush_min_spans as usize),
            client: Arc::new(agent::AgentClient::new(
                &options.url,
                options.tracer_version,
                options.node_version,
                protocol.path(),
            )),
            protocol,
            layers: Layers::from_env(),
        }
    }

    /// Lengths are in elements — words, doubles, bytes — matching each view's type.
    #[napi]
    pub fn flush(
        &mut self,
        env: Env,
        event_words: u32,
        double_slots: u32,
        string_bytes: u32,
    ) -> Result<()> {
        if !self.layers.decode {
            return Ok(());
        }

        let decoded = {
            let events = &self.events_view[..(event_words as usize).min(self.events_view.len())];
            let doubles = &self.doubles_view[..(double_slots as usize).min(self.doubles_view.len())];
            let strings = &self.strings_view[..(string_bytes as usize).min(self.strings_view.len())];
            decode::decode(events, doubles, strings)
        };

        if !self.layers.process {
            return Ok(());
        }
        let chunks = self.assembler.process(decoded);
        if chunks.is_empty() {
            return Ok(());
        }

        if !self.layers.encode {
            return Ok(());
        }
        let payload = encode::encode(&chunks, self.protocol);

        if !self.layers.flush {
            return Ok(());
        }
        env.spawn(FlushToAgent {
            payload,
            trace_count: chunks.len(),
            client: Arc::clone(&self.client),
        })?;

        Ok(())
    }
}

/// The only stage that outlives `flush()`. `env.spawn` queues this on N-API's own
/// worker pool — no tokio, consistent with the `ureq` choice — and returns
/// immediately, so `flush()` never waits on the HTTP round trip.
struct FlushToAgent {
    payload: Vec<u8>,
    trace_count: usize,
    client: Arc<agent::AgentClient>,
}

impl Task for FlushToAgent {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<()> {
        // A send failure is reported and dropped rather than returned: an `Err` here
        // rejects the promise `env.spawn` produced, which nothing on the JS side
        // holds, and an unhandled rejection would take the host application down
        // over an unreachable agent.
        if let Err(message) = self.client.send(&self.payload, self.trace_count) {
            eprintln!("native-spans: failed to send {} trace(s): {message}", self.trace_count);
        }
        Ok(())
    }

    fn resolve(&mut self, _env: Env, _output: ()) -> Result<()> {
        Ok(())
    }
}
