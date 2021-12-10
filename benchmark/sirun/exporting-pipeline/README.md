This test creates a 30 span trace (of similar format to the encoding test).
These spans are then passed through the formatting, encoding, and writing steps
in our pipeline, and sent to a dummy agent. Once a span (i.e. a trace) is added
to the exporter, we then proceed to the next iteration via `setImmediate`, and
run for 25000 iterations.

There's a variant for each of our encodings/endpoints.
