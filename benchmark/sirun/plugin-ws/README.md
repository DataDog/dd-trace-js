Measures the per-message websocket instrumentation hot path through the real
plugin: `WSProducerPlugin`/`WSReceiverPlugin` `bindStart` (resource-path split,
meta literal, `startSpan`) and `end` (the span link plus the span-pointer hash,
built from the handshake's distributed context). The `send` variant drives the
producer, `receive` the receiver; both run against a handshake span context that
carries a remote parent so the span-pointer path is exercised.
