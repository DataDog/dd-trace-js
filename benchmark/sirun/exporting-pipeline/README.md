Measures the front of the export pipeline: `SpanProcessor.process` runs priority
and span sampling, then `spanFormat` turns each finished span into its wire
shape. A no-op exporter receives the formatted chunk so the loop stays CPU-bound
with flat memory.

The encoder and the agent socket are out of scope on purpose: `encoding` covers
the encoder, and the real flush is a deferred `unref`'d timer that barely fires
in a short run. Variants toggle the stats (DSM) path, which also runs in
`process`.
