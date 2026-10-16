This test initializes a tracer and creates many spans. Depending on the variant,
it either finishes them immediately or in batches. Most variants use the no-op
scope manager to isolate span construction; the `activate-*` pair instead uses
the real scope manager to measure a complete activate/finish/restore lifecycle
with the thread-context writer explicitly disabled or enabled.

The processor is replaced before timing so no span processing or exporting is
measured. Context-enabled results measure the writer on Linux runtimes using
AsyncContextFrame; unsupported runtimes exercise its no-op fallback.
