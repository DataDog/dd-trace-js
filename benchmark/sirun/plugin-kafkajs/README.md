Measures the per-message Data Streams Monitoring hot path for the kafkajs
producer: `getMessageSize` plus `DsmPathwayCodec.encode`, which varint-encodes
the pathway context into a reused scratch buffer and base64s it into the message
headers. Variants cover a small keyed message, a larger message with user
headers, and a mixed batch. Header trace-context injection is covered by the
propagation bench and is not duplicated here.
