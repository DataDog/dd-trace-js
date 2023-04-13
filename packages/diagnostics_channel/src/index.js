'use strict'

const {
  Channel,
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
      const unsubscribe = ch.unsubscribe

      ch.subscribe = function () {
        delete ch.subscribe
        delete ch.unsubscribe

        const result = subscribe.apply(this, arguments)

        this.subscribe(() => {}) // Keep it active forever.

        return result
      }

      if (ch.unsubscribe === Channel.prototype.unsubscribe) {
        // Needed because another subscriber could have subscribed to something
        // that we unsubscribe to before the library is loaded.
        ch.unsubscribe = function () {
          delete ch.subscribe
          delete ch.unsubscribe

          this.subscribe(() => {}) // Keep it active forever.

          return unsubscribe.apply(this, arguments)
        }
      }

      channels.add(ch)
    }

    return ch
  }
}

module.exports = dc
