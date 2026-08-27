'use strict'

const { storage } = require('../../../../datadog-core')

const legacyStorage = storage('legacy')

class ConnectionLifecycleAdapter {
  /**
   * Capture the caller store before the driver starts acquiring a connection.
   *
   * @param {object} context Raw connection lifecycle context.
   * @returns {void}
   */
  start (context) {
    context.currentStore = legacyStorage.getStore()
  }

  /**
   * Restore the caller store around driver-owned acquisition completion.
   *
   * @param {object} context Raw connection lifecycle context.
   * @returns {object | undefined} Store captured at connection start.
   */
  finish (context) {
    return context.currentStore
  }

  /**
   * Capture a query caller before MariaDB defers command execution.
   *
   * @param {object} context Raw command lifecycle context.
   * @returns {void}
   */
  captureParent (context) {
    context.parentStore = legacyStorage.getStore()
  }

  /**
   * Isolate driver-owned connection creation from application tracing context.
   *
   * @returns {{noop: true}} Legacy no-op store.
   */
  skip () {
    return { noop: true }
  }
}

module.exports = ConnectionLifecycleAdapter
