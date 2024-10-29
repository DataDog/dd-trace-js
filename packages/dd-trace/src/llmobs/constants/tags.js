'use strict'

module.exports = {
  SPAN_KINDS: ['llm', 'agent', 'workflow', 'task', 'tool', 'embedding', 'retrieval'],
  SPAN_KIND: '_ml_obs.meta.span.kind',
  SESSION_ID: '_ml_obs.session_id',
  METADATA: '_ml_obs.meta.metadata',
  METRICS: '_ml_obs.metrics',
  ML_APP: '_ml_obs.meta.ml_app',
  PROPAGATED_PARENT_ID_KEY: '_dd.p.llmobs_parent_id',
  PARENT_ID_KEY: '_ml_obs.llmobs_parent_id',
  TAGS: '_ml_obs.tags',
  NAME: '_ml_obs.name',
  TRACE_ID: '_ml_obs.trace_id',
  PROPAGATED_TRACE_ID_KEY: '_dd.p.llmobs_trace_id',
  ROOT_PARENT_ID: 'undefined',

  MODEL_NAME: '_ml_obs.meta.model_name',
  MODEL_PROVIDER: '_ml_obs.meta.model_provider',

  INPUT_DOCUMENTS: '_ml_obs.meta.input.documents',
  INPUT_MESSAGES: '_ml_obs.meta.input.messages',
  INPUT_VALUE: '_ml_obs.meta.input.value',

  OUTPUT_DOCUMENTS: '_ml_obs.meta.output.documents',
  OUTPUT_MESSAGES: '_ml_obs.meta.output.messages',
  OUTPUT_VALUE: '_ml_obs.meta.output.value',

  INPUT_TOKENS_METRIC_KEY: 'input_tokens',
  OUTPUT_TOKENS_METRIC_KEY: 'output_tokens',
  TOTAL_TOKENS_METRIC_KEY: 'total_tokens',

  DROPPED_IO_COLLECTION_ERROR: 'dropped_io'
}
