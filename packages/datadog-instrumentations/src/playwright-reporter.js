'use strict'

const { channel } = require('dc-polyfill')

const reporterErrorCh = channel('ci:playwright:reporter:error')

module.exports = class DatadogPlaywrightReporter {
  /**
   * Marks the beginning of reporter finalization so later reporter errors can be identified.
   *
   * @returns {void}
   */
  onEnd () {
    this.isFinalizing = true
  }

  /**
   * Reports errors emitted by Playwright while later reporters are finalizing.
   *
   * @param {object} error
   * @returns {void}
   */
  onError (error) {
    if (this.isFinalizing) reporterErrorCh.publish(error)
  }

  /**
   * Keeps the internal reporter from affecting Playwright's output reporter selection.
   *
   * @returns {boolean}
   */
  printsToStdio () {
    return false
  }
}
