This test sends a single trace 10000 times to the encoder. Each trace is
pre-formatted (as the encoder requires) and consists of 30 spans with the same
content in each of them. The IDs are all randomized. A null writer is provided
to the encoder, so writing operations are not included here.

The span content contains three metas, three metrics, and reasonable values for
everything else.

The two variants correspond to the v0.4 and v0.5 encoders.
