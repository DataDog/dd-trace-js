Critical-path bench. `id()` generates the pseudo-random 64-bit id every span and
trace needs (from a batch buffer that refills every 8192 draws); `id(hex, 16)`
parses an inbound id from a distributed-tracing header. Both run on the request
hot path and aren't measured elsewhere. Variants: `generate`, `parse-64bit`,
`parse-128bit`.
