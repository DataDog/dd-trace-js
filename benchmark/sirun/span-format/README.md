# span-format

Measures `span_format.format()`, the per-span step that runs before the msgpack
encoder: the per-tag switch that splits the tag bag into meta/metrics, key/value
truncation, error-field extraction, and root/chunk tag stamping. Variants cover a
flat web span, a wide tag bag, an errored span, and a typical HTTP-server span.
