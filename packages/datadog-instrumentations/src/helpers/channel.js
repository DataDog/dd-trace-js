'use strict'

/**
 * @template {unknown[]} T
 * @param {(...args: T) => void} onDone
 * @returns {(...args: T) => void}
 */
function getCompletion (onDone) {
  let hasCompleted = false
  return (...args) => {
    if (hasCompleted) return

    hasCompleted = true
    onDone(...args)
  }
}

/**
 * @template {unknown[]} T
 * @param {import('node:diagnostics_channel').Channel} channel
 * @param {Record<string, unknown>} payload
 * @param {(...args: T) => void} onDone
 * @returns {void}
 */
function publishWithCompletion (channel, payload, onDone) {
  const complete = getCompletion(onDone)
  channel.publish({ ...payload, onDone: complete })
  if (!channel.hasSubscribers) complete()
}

/**
 * @template {unknown[]} T
 * @param {import('node:diagnostics_channel').Channel} channel
 * @param {Record<string, unknown> & { onDone?: (...args: T) => void }} payload
 * @param {(...args: T) => void} onDone
 * @returns {void}
 */
function runStoresWithCompletion (channel, payload, onDone) {
  const complete = getCompletion(onDone)
  payload.onDone = complete
  channel.runStores(payload, () => {})
  if (!channel.hasSubscribers) complete()
}

/**
 * @template T
 * @param {import('node:diagnostics_channel').Channel} channel
 * @param {Record<string, unknown>} [payload]
 * @returns {Promise<T>}
 */
function getChannelPromise (channel, payload = {}) {
  return new Promise(resolve => {
    publishWithCompletion(channel, payload, resolve)
  })
}

/**
 * @template T
 * @param {import('node:diagnostics_channel').Channel} channel
 * @param {Record<string, unknown>} [payload]
 * @returns {Promise<T>}
 */
function getRunStoresPromise (channel, payload = {}) {
  return new Promise(resolve => {
    runStoresWithCompletion(channel, { ...payload }, resolve)
  })
}

module.exports = {
  getChannelPromise,
  getRunStoresPromise,
  publishWithCompletion,
  runStoresWithCompletion,
}
