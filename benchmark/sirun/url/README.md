Measures the per-request URL hot path for HTTP server spans, the sequence
addRequestTags runs once per inbound request: `extractURL` (rebuild the URL from
the request headers/socket/url), `obfuscateQs` (query-string secret redaction
with the shipped default regex) and `calculateHttpEndpoint` (path normalization
for endpoint aggregation, regex per segment). Driven over duck-typed requests
with int/hex ids, secret-bearing query strings, and plain/TLS sockets.
