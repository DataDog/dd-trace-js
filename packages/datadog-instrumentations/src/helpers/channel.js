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
 * @param {import('node:diagnostics_channel').Channel} channel
 * @param {Record<string, unknown>} payload
 * @param {() => void} onDone
 * @returns {void}
 */
function publishWithCompletionBarrier (channel, payload, onDone) {
  let pendingCompletions = 1
  const registerCompletion = () => {
    pendingCompletions++
    return getCompletion(() => {
      pendingCompletions--
      if (pendingCompletions === 0) onDone()
    })
  }

  channel.publish({ ...payload, registerCompletion })
  pendingCompletions--
  if (pendingCompletions === 0) onDone()
}

/**
 * @param {import('node:diagnostics_channel').Channel} channel
 * @param {Record<string, unknown>} [payload]
 * @returns {Promise<void>}
 */
function getChannelBarrierPromise (channel, payload = {}) {
  return new Promise(resolve => {
    publishWithCompletionBarrier(channel, payload, resolve)
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
  getChannelBarrierPromise,
  getChannelPromise,
  getRunStoresPromise,
  publishWithCompletion,
  publishWithCompletionBarrier,
  runStoresWithCompletion,
}
