This benchmark measures the wire-protocol propagation hot path that fires on every
traced HTTP request: extract on incoming, inject on outgoing. It covers W3C,
Datadog, and baggage propagation through `text_map.js` and `tracestate.js`.
