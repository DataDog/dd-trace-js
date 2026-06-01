This benchmark measures `encodeUnicode` plus the surrounding `JSON.stringify` replacer
that the LLMObs writer hands to every payload flush
(`packages/dd-trace/src/llmobs/writers/base.js#_encode`). LLMObs is opt-in
(`DD_LLMOBS_ENABLED=true`); for customers who run it, the replacer fires on every
span flush.
