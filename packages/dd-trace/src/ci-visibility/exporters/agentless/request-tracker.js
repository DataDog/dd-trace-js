'use strict'

const BaseWriter = require('../../../exporters/common/writer')
const FinalFlushRequestTracker = require('../../../exporters/common/final-flush-request-tracker')
const { createFinalFlushTimeoutError } = require('../../final-flush')

class TestOptimizationRequestTracker extends FinalFlushRequestTracker {
  /**
   * Creates request tracking for a Test Optimization writer.
   *
   * @param {BaseWriter} writer
   */
  constructor (writer) {
    super(
      (done, options) => BaseWriter.prototype.flushDirect.call(writer, done, options),
      createFinalFlushTimeoutError
    )
  }
}

module.exports = TestOptimizationRequestTracker
