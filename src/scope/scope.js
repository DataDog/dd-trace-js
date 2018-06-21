'use strict'

/**
 * The Datadog Scope. This is the type returned by ScopeManager.activate().
 *
 * @hideconstructor
 */
class Scope {
  constructor (span, execution, finishSpanOnClose) {
    this._span = span
    this._execution = execution
    this._finishSpanOnClose = !!finishSpanOnClose
  }

  /**
   * Get the span wrapped by this scope.
   *
   * @returns {Scope} The wrapped span.
   */
  span () {
    return this._span
  }

  /**
   * Close the scope, and finish the span if the scope was created with `finishSpanOnClose` set to true.
   */
  close () {
    if (this._finishSpanOnClose) {
      this._span.finish()
    }

    this._execution.remove(this)
  }
}

module.exports = Scope
