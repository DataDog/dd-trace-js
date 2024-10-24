'use strict'

const { channel } = require('dc-polyfill')

module.exports = {
  injectCh: channel('dd-trace:span:inject'),
  spanProcessCh: channel('dd-trace:span:process'),
  evalMetricAppendCh: channel('llmobs:eval-metric:append'),
  flushCh: channel('llmobs:writers:flush')
}
