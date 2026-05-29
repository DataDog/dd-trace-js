Measures the per-request URL hot path for HTTP server spans:
`calculateHttpEndpoint` (path normalization for endpoint aggregation, regex per
segment) and `obfuscateQs` (query-string secret redaction with the shipped
default regex). Both run once per inbound request over a mix of representative
URLs with int/hex ids and secret-bearing query strings.
