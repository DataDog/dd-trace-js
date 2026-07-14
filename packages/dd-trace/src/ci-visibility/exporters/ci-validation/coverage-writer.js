'use strict'

class CiValidationCoverageWriter {
  /**
   * Creates an offline coverage writer.
   *
   * @param {object} sink bounded validation sink
   */
  constructor (sink) {
    this._sink = sink
  }

  /**
   * Writes coverage data to the shared offline artifact.
   *
   * @param {object|object[]} payload formatted coverage payload
   */
  append (payload) {
    this._sink.writeCoverage(payload)
  }

  /**
   * Completes synchronously because coverage records are written on append.
   *
   * @param {Function} [done] completion callback
   */
  flush (done = () => {}) {
    done()
  }

  /**
   * Ignores metadata because coverage output already carries its formatted payload.
   *
   * @returns {void}
   */
  addMetadataTags () {}
}

module.exports = CiValidationCoverageWriter
