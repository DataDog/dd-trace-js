'use strict'

class BinaryPropagator {
  /**
   * Binary propagation is unsupported; nothing is ever written.
   *
   * @returns {boolean} Always `false`.
   */
  inject (spanContext, carrier) {
    return false
  }

  extract (carrier) {
    return null
  }
}

module.exports = BinaryPropagator
