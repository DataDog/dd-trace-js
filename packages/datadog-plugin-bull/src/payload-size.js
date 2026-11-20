'use strict'

const { getSizeOrZero } = require('../../dd-trace/src/datastreams')

/**
 * @param {unknown} data
 */
function getPayloadSize (data) {
  try {
    return getSizeOrZero(JSON.stringify(data))
  } catch {
    return 0
  }
}

module.exports = { getPayloadSize }
