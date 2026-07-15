'use strict'

/**
 * @template {unknown[]} T
 * @param {import('node:diagnostics_channel').Channel} channel
 * @param {Record<string, unknown>} payload
 * @param {(...args: T) => void} onDone
 * @returns {void}
 */
function publishWithCompletion (channel, payload, onDone) {
  let hasCompleted = false
  const complete = (...args) => {
    if (hasCompleted) return

    hasCompleted = true
    onDone(...args)
  }

  channel.publish({ ...payload, onDone: complete })
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

module.exports = {
  getChannelPromise,
  publishWithCompletion,
}
