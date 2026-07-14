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
   * Writes coverage data to its offline payload-file directory.
   *
   * @param {object|object[]} payload formatted coverage payload
   */
  append (payload) {
    this._sink.writeCoverage(payload)
  }

  /**
   * Completes synchronously because coverage payload files are written on append.
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
