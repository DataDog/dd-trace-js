'use strict'

const Sequencer = require('@jest/test-sequencer').default

module.exports = class TestSequencer extends Sequencer {
  /**
   * @param {Array<{ path: string }>} tests
   * @returns {Array<{ path: string }>}
   */
  sort (tests) {
    return tests.sort((a, b) => a.path.localeCompare(b.path))
  }
}
