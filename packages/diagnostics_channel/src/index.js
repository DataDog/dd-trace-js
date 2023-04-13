'use strict'

const {
  channel
} = require('diagnostics_channel') // eslint-disable-line n/no-restricted-require

const [major, minor] = process.versions.node.split('.')
const channels = new WeakSet()

// Our own DC with a limited subset of functionality stable across Node versions.
// TODO: Move the rest of the polyfill here.
// TODO: Switch to using global subscribe/unsubscribe/hasSubscribers.
const dc = { channel }

// Prevent going to 0 subscribers to avoid bug in Node.
// See https://github.com/nodejs/node/pull/47520
if (major === '19' && minor === '9') {
  dc.channel = function () {
    const ch = channel.apply(this, arguments)

    if (!channels.has(ch)) {
      const subscribe = ch.subscribe

      ch.subscribe = function () {
        delete ch.subscribe

        const result = subscribe.apply(this, arguments)

        this.subscribe(() => {}) // Keep it active forever.

        return result
      }

      channels.add(ch)
    }

    return ch
  }
}

module.exports = dc
