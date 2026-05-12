This benchmark measures the wire-protocol propagation hot path that fires on every
traced HTTP request: extract on incoming, inject on outgoing. Both go through
`text_map.js` and `tracestate.js`, the broadest customer surface in the library.
