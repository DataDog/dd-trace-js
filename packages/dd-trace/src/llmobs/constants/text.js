'use strict'

module.exports = {
  DROPPED_VALUE_TEXT: "[This value has been dropped because this span's size exceeds the 5MB size limit.]",
  UNSERIALIZABLE_VALUE_TEXT: 'Unserializable value',
  INCOMPATIBLE_INITIALIZATION:
    'Cannot send LLM Observability data without a running agent or without both a Datadog API key and site. ' +
    'Ensure these configurations are set before running your application.',
}
