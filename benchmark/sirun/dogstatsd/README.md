# dogstatsd

Measures the in-process DogStatsD egress formatting that every runtime and custom
metric runs through: `DogStatsDClient._add` builds the `stat:value|type` line,
splices global and per-metric tags, and appends to the 1KB datagram buffer. The
`aggregated` variant drives the `MetricsAggregationClient` tag tree that runtime
metrics accumulate before flushing. The UDP socket is stubbed; nothing leaves the
process.
