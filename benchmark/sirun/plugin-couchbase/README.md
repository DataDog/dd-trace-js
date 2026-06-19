# plugin-couchbase

Measures `CouchBasePlugin.startSpan` tag assembly: the base tag bag plus the
bucket/collection names and the per-operation custom tags, before delegating to
the storage base (stubbed here). Variants cover a query and an upsert.
