'use strict'

const OTEL_B3_STYLE = 'OTel b3'
const OTEL_B3_LABEL = 'b3'

/**
 * @param {string[]} styles
 * @param {string} separator
 */
function formatPropagationStyles (styles, separator) {
  return styles.join(separator).replaceAll(OTEL_B3_STYLE, OTEL_B3_LABEL)
}

module.exports = { OTEL_B3_LABEL, OTEL_B3_STYLE, formatPropagationStyles }
