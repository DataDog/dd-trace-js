# llmobs-evaluations

Measures the LLMObs evaluation-metrics writer egress: `append` (buffer + byte
sizing) and `flush` (`makePayload` plus `_encode`, JSON.stringify with the
encodeUnicode replacer). It shares the encode path with the `llmobs` (span writer)
bench but covers the distinct evaluations writer and its payload shape. Variants
cover categorical metrics, score metrics, and reasoned metrics with non-ASCII text
that exercises the encodeUnicode branch.
