'use strict'

const { storage } = require('../../datadog-core')

const EMPTY_ARGUMENTS = Object.freeze([])

const queryChannels = Object.freeze({
  asyncEnd: 'apm:mariadb:query:finish',
  error: 'apm:mariadb:query:error',
  start: 'apm:mariadb:query:start',
})
const poolAcquireChannels = Object.freeze({
  asyncEnd: 'apm:mariadb:pool:acquire:finish',
  error: 'apm:mariadb:pool:acquire:finish',
  start: 'apm:mariadb:pool:acquire:start',
  startMode: 'publish',
})

module.exports = {
  /**
   * Resolve one MariaDB semantic operation to its existing diagnostic channels.
   *
   * @param {{name: string}} target Pipeline operation target.
   * @returns {{start: string, asyncEnd: string, error: string, startMode?: 'publish'}} Channel mapping.
   */
  channels (target) {
    if (target.name === 'query') return queryChannels
    if (target.name === 'pool.acquire') return poolAcquireChannels

    throw new TypeError(`Unknown MariaDB pipeline target "${target.name}"`)
  },

  /**
   * Adapt the existing MariaDB context in place and retain the original caller store.
   *
   * MariaDB v3 constructs commands before they enter the driver's queue. The compatibility
   * base records that caller store first; v2 and pool acquisition capture it here at start.
   *
   * @param {Record<string, unknown>} context MariaDB instrumentation context.
   * @returns {Record<string, unknown> & {arguments: readonly unknown[]}} Pipeline invocation.
   */
  invocation (context) {
    if (context === null || typeof context !== 'object') {
      throw new TypeError('MariaDB pipeline received an invalid invocation')
    }

    context.arguments ||= EMPTY_ARGUMENTS
    if (!Object.hasOwn(context, 'sourceParentStore')) {
      context.sourceParentStore = storage('legacy').getStore()
    }
    return context
  },
}
