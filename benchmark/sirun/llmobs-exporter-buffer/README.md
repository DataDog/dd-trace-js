# LLMObs exporter buffer

Measures buffering while Agent discovery is pending. Each operation creates a
new trace chunk with one full LLMObs span and approximately 15 KB of input data.
Discovery is stubbed to avoid network requests and keep the buffer pending.

The `fill` variant submits 1,000 spans. The `evict` variant submits 10,000 spans
to exercise eviction. Both assert that the buffer retains 1,000 spans.

Sirun collects timing, instructions, and the custom StatsD gauges
`llmobs-exporter-buffer.retained_heapUsed_bytes`, `retained_external_bytes`, and
`retained_rss_bytes` (all with the same prefix). These are differences between
memory samples taken after forced GC before and after the workload. RSS and
external memory can include allocator retention; they are not retained heap size.
The measured loop includes payload creation and buffering, but excludes the
explicit memory-sampling GCs from the throughput metric.

Run from this directory with `node ../run-all-variants.js`.
