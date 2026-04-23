'use strict'

module.exports = {
  SPAN_KINDS: ['llm', 'agent', 'workflow', 'task', 'tool', 'embedding', 'retrieval'],
  SPAN_KIND: '_ml_obs.meta.span.kind',
  SESSION_ID: '_ml_obs.session_id',
  DECORATOR: '_ml_obs.decorator',
  INTEGRATION: '_ml_obs.integration',
  METADATA: '_ml_obs.meta.metadata',
  METRICS: '_ml_obs.metrics',
  ML_APP: '_ml_obs.meta.ml_app',
  PROPAGATED_PARENT_ID_KEY: '_dd.p.llmobs_parent_id',
  PROPAGATED_ML_APP_KEY: '_dd.p.llmobs_ml_app',
  PARENT_ID_KEY: '_ml_obs.llmobs_parent_id',
  TAGS: '_ml_obs.tags',
  NAME: '_ml_obs.name',
  TRACE_ID: '_ml_obs.trace_id',
  PROPAGATED_TRACE_ID_KEY: '_dd.p.llmobs_trace_id',
  ROOT_PARENT_ID: 'undefined',
  DEFAULT_PROMPT_NAME: 'unnamed-prompt',
  INTERNAL_CONTEXT_VARIABLE_KEYS: '_dd_context_variable_keys',
  INTERNAL_QUERY_VARIABLE_KEYS: '_dd_query_variable_keys',

  MODEL_NAME: '_ml_obs.meta.model_name',
  MODEL_PROVIDER: '_ml_obs.meta.model_provider',
  UNKNOWN_MODEL_PROVIDER: 'unknown',

  INPUT_DOCUMENTS: '_ml_obs.meta.input.documents',
  INPUT_MESSAGES: '_ml_obs.meta.input.messages',
  INPUT_VALUE: '_ml_obs.meta.input.value',
  INPUT_PROMPT: '_ml_obs.meta.input.prompt',

  OUTPUT_DOCUMENTS: '_ml_obs.meta.output.documents',
  OUTPUT_MESSAGES: '_ml_obs.meta.output.messages',
  OUTPUT_VALUE: '_ml_obs.meta.output.value',

  INPUT_TOKENS_METRIC_KEY: 'input_tokens',
  OUTPUT_TOKENS_METRIC_KEY: 'output_tokens',
  TOTAL_TOKENS_METRIC_KEY: 'total_tokens',
  CACHE_READ_INPUT_TOKENS_METRIC_KEY: 'cache_read_input_tokens',
  CACHE_WRITE_INPUT_TOKENS_METRIC_KEY: 'cache_write_input_tokens',
  CACHE_WRITE_5M_INPUT_TOKENS_METRIC_KEY: 'ephemeral_5m_input_tokens',
  CACHE_WRITE_1H_INPUT_TOKENS_METRIC_KEY: 'ephemeral_1h_input_tokens',
  REASONING_OUTPUT_TOKENS_METRIC_KEY: 'reasoning_output_tokens',

  DROPPED_IO_COLLECTION_ERROR: 'dropped_io',

  PROMPT_TRACKING_INSTRUMENTATION_METHOD: 'prompt_tracking_instrumentation_method',
  PROMPT_MULTIMODAL: 'prompt_multimodal',
  INSTRUMENTATION_METHOD_AUTO: 'auto',
  INSTRUMENTATION_METHOD_ANNOTATED: 'annotated',
  INSTRUMENTATION_METHOD_UNKNOWN: 'unknown',

  ROUTING_API_KEY: '_dd.llmobs.routing.api_key',
  ROUTING_SITE: '_dd.llmobs.routing.site',

  // OTel baggage keys propagated by the RUM browser SDK's `propagateTraceBaggage`
  // option. When present on the active span context (typically extracted from an
  // incoming HTTP request), these values are auto-applied to LLMObs spans so RUM
  // sessions and users correlate to LLM traces without any manual tagging.
  RUM_BAGGAGE_SESSION_ID_KEY: 'session.id',
  RUM_BAGGAGE_USER_ID_KEY: 'user.id',
  RUM_BAGGAGE_ACCOUNT_ID_KEY: 'account.id',

  // LLMObs tag keys aligned with Datadog standard attributes for user identity.
  USER_ID_TAG_KEY: 'usr.id',
  USER_ACCOUNT_ID_TAG_KEY: 'usr.account_id',
}
