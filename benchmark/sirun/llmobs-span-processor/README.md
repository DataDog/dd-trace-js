# llmobs-span-processor

Measures `LLMObsSpanProcessor.format()`, run once per finished LLMObs span: it
reads the tagger's per-span tag map and the APM span tags, then builds the LLMObs
event (kind-specific input/output, metadata, metrics, tags, error). The existing
`llmobs` bench covers the writer encode; this covers the per-span formatting that
feeds it. Variants cover llm chat, embedding, retrieval, and agent spans. It
allocates per call, so it is GC-noisy locally and CI's pinned core is the gate.
