Measures the per-log-record trace-context injection for pino JSON logs:
`LogPropagator.inject` (builds the `dd` field with 128-bit trace/span ids and
service/version/env) followed by the `handleJsonLine` splice that inserts
`,"dd":{...}` into the line pino already produced. Both run once per record on
the logging hot path under high-volume structured logging.
