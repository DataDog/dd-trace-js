# Native Spans Scaling Issue

## Summary

Native span throughput degrades over time under sustained load. A 30K-request
benchmark shows throughput dropping from ~3900 req/s to ~2700 req/s (31% drop),
while JS-mode tracing stays stable at ~7000 req/s.

## Reproduction

```bash
# Requires: dd-trace-js on bengl/native-spans, libdatadog-nodejs on bengl/native-spans (yarn linked)
# Build the native addon: cd libdatadog-nodejs && napi build --platform -p pipeline-native -o prebuilds/pipeline-native --release

DD_TRACE_EXPERIMENTAL_NATIVE_SPANS_ENABLED=1 timeout 60 node -e "
const http = require('http')
const agent = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}') }) })
agent.listen(8126, () => {
  const tracer = require('./packages/dd-trace').init({ hostname:'127.0.0.1', port:8126, flushInterval:0, plugins:false })
  tracer.use('http'); tracer.use('express')
  const express = require('express')
  const app = express()
  app.use((req,res,next)=>{const s=tracer.scope().active();if(s)s.setTag('auth','u');next()})
  app.get('/api/users/:id',(req,res)=>{
    const span=tracer.startSpan('db',{childOf:tracer.scope().active(),tags:{'service.name':'pg','resource.name':'SELECT','span.type':'sql','db.type':'pg'}})
    setTimeout(()=>{span.setTag('db.rows',1);span.finish();res.json({id:req.params.id})},1)
  })
  app.get('/api/health',(req,res)=>res.json({ok:true}))
  const server=app.listen(0,()=>{
    const port=server.address().port;let done=0,fly=0;let batchStart=Date.now()
    function go(){if(done>=30000)return;if(fly>=20)return;fly++
      http.get({hostname:'127.0.0.1',port,path:done%5===0?'/api/health':'/api/users/'+(done%100+1)},(res)=>{
        res.resume();res.on('end',()=>{fly--;done++
          if(done%5000===0){const elapsed=Date.now()-batchStart;process.stderr.write(done+': '+Math.round(5000/elapsed*1000)+' req/s, rss='+Math.round(process.memoryUsage().rss/1024/1024)+'MB\n');batchStart=Date.now()}
          if(done>=30000){server.close();agent.close();setTimeout(()=>process.exit(),500);return}
          setImmediate(go)
        })
      }).on('error',()=>{fly--;done++;setImmediate(go)})
      setImmediate(go)
    }
    for(let i=0;i<20;i++)go()
  })
})
"
```

Expected output showing degradation:
```
5000: 3799 req/s, rss=264MB
10000: 3962 req/s, rss=275MB
15000: 3600 req/s, rss=292MB
20000: 3145 req/s, rss=297MB
25000: 2703 req/s, rss=300MB
30000: 2567 req/s, rss=301MB
```

JS mode with same setup is stable at ~7000 req/s.

## What we've ruled out

1. **The mock agent isn't the bottleneck.** JS mode with the same mock agent
   runs at stable 7000 req/s.

2. **The send path isn't the cause.** Stubbing `sendPreparedChunk` to a no-op
   doesn't fix the degradation.

3. **The change buffer overflow isn't the cause.** `cqbCount` stays at 0
   between flushes (the buffer is flushed properly). Only ~280 ops accumulate
   per flush cycle — well within the 8MB buffer.

4. **The string table isn't the cause.** Only 50 unique strings after 5000
   requests. No growth.

5. **`prepared_spans` leaking isn't the primary cause.** We changed from
   `Option<Vec<Span>>` to `Vec<Vec<Span>>` queue — no improvement.

6. **Mutex contention isn't the cause.** Switching from `std::sync::Mutex` to
   `RefCell` gave ~13% improvement but didn't fix the degradation pattern.

7. **It's not JS-side overhead.** Stubbing ALL native addon methods
   (`prepareChunk`, `sendPreparedChunk`, `flushChangeQueue`,
   `stringTableInsertOne`) to JS no-ops produces stable 7500 req/s with
   no degradation. The degradation is definitively in the Rust code.

## What we know

- RSS grows from ~264MB to ~303MB over 30K requests (native external memory
  grows from ~17MB to ~27MB; JS heap stays similar to JS mode).

- Degradation is **proportional to total requests processed**, not to
  concurrent connections or buffer size.

- The Rust code paths involved in each request:
  1. `stringTableInsertOne(key, val)` — Vec insert (cache hit after warmup)
  2. `flushChangeQueue()` → `flush_change_buffer()` — parses change buffer
     ops, inserts into `FxHashMap<u64, Span>`, looks up `Vec<Option<Text>>`
     string table
  3. `prepareChunk(len, firstIsLocalRoot, chunk)` → `flush_change_buffer()`
     + `flush_chunk(spanIds)` — removes spans from HashMap, builds
     `Vec<Span>`, sets `_dd.top_level`/`_dd.measured`
  4. `sendPreparedChunk()` → `send_trace_chunks_async(chunks)` — serializes
     with msgpack, sends via hyper HTTP

## Likely causes to investigate

1. **Rust allocator fragmentation.** The spans HashMap repeatedly
   inserts and removes entries. The `FxHashMap` doesn't shrink after removals
   — it keeps its allocated capacity. Over time, the internal bucket array
   grows from rehashing but never shrinks. Each `flush_change_buffer` inserts
   into a HashMap that has increasingly sparse bucket distribution.

2. **Hyper connection pool growth.** The `TraceExporter` uses hyper's HTTP
   client with a connection pool. Each `send_trace_chunks_async` may
   accumulate connections or buffers that aren't cleaned up between sends.

3. **BytesString / Arc<str> accumulation.** The `Span` struct stores
   `BytesString` (which is `Arc<str>`) for name, service, resource, type.
   The string table stores `Arc<str>` clones. Even after spans are removed
   from the HashMap, the `Arc<str>` reference counts may not drop to zero
   if something else holds a reference.

4. **Trace map growth.** The `SmallTraceMap` (or `FxHashMap<u128, Trace>`)
   tracks active traces. If `flush_chunk` doesn't always clean up the trace
   entry (e.g., if `span_count` doesn't reach zero for some traces), the map
   grows indefinitely.

5. **tokio runtime overhead.** The napi addon uses a tokio runtime for async
   send. Each `sendPreparedChunk` spawns work on this runtime. If the runtime
   accumulates tasks or internal state, it could slow down over time.

## How to investigate

1. **Add a diagnostic method** to `NativeSpanState` that returns internal
   counts: `spans.len()`, `traces.len()`, `string_table.len()`,
   `span_headers.len()` (if applicable), `prepared_chunks.len()`. Call it
   periodically during the benchmark to see what grows.

2. **Profile with `perf` or `flamegraph`** on Linux (or `Instruments` on
   macOS) to see which Rust functions take progressively more time.

3. **Add `HashMap::shrink_to_fit()`** calls after `flush_chunk` removes
   spans to prevent unbounded capacity growth.

4. **Test with jemalloc** (`#[global_allocator]`) instead of the system
   allocator to see if fragmentation behavior changes.

5. **Log the time spent in each Rust operation** per `prepareChunk` call
   to identify which step is getting slower.

## Architecture context

The change buffer protocol writes span operations (create, setTag, finish)
as binary opcodes into a shared memory buffer. JS writes to the buffer via
DataView. Rust reads and processes the buffer during `flush_change_buffer()`.
Spans live in a `FxHashMap<u64, Span>` until `flush_chunk()` removes them
for export.

Key files:
- `libdatadog/libdd-trace-utils/src/change_buffer/mod.rs` — `ChangeBufferState`, `flush_change_buffer`, `flush_chunk`
- `libdatadog-nodejs/crates/pipeline-native/src/lib.rs` — napi bindings
- `dd-trace-js/packages/dd-trace/src/native/native_spans.js` — JS change buffer writer
- `dd-trace-js/packages/dd-trace/src/exporters/native/index.js` — export path
