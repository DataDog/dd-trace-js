Measures the per-query DBM comment injection for postgres: `injectDbmQuery` ->
`createDbmComment` builds the Datadog Block Monitoring SQL comment and splices it
onto the query. The `service` variant is the common cached-prefix mode; `full`
adds sampling and a real traceparent per query. Drives the real plugin and span
context so encode/getTags/toTraceparent run as in production.
