'use strict'

const spans = new WeakMap()

/**
 * Register the Datadog span wrapped by an OTel bridge object.
 *
 * @param {object} bridgeSpan
 * @param {import('../opentracing/span')} datadogSpan
 */
function registerDatadogSpan (bridgeSpan, datadogSpan) {
  spans.set(bridgeSpan, datadogSpan)
}

/**
 * Return the Datadog span wrapped by an OTel bridge object.
 *
 * @param {object} bridgeSpan
 * @returns {import('../opentracing/span')|undefined}
 */
function getDatadogSpan (bridgeSpan) {
  return spans.get(bridgeSpan)
}

module.exports = { getDatadogSpan, registerDatadogSpan }
