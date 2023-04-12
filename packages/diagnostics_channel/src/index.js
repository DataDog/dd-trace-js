'use strict'

const {
  Channel,
  channel
} = require('diagnostics_channel') // eslint-disable-line n/no-restricted-require

const [major, minor] = process.versions.node.split('.')

// Our own DC with a limited subset of functionality stable across Node versions.
// TODO: Move the rest of the polyfill here.
// TODO: Switch to using global subscribe/unsubscribe/hasSubscribers.
const dc = { channel }

// Prevent going to 0 subscribers to avoid bug in Node.
// See https://github.com/nodejs/node/pull/47520
if (major === '19' && minor === '9') {
  dc.channel = function () {
    const maybeInactive = channel.apply(this, arguments)

    if (maybeInactive.subscribe === Channel.prototype.subscribe) {
      const subscribe = maybeInactive.subscribe

      maybeInactive.subscribe = function () {
        delete maybeInactive.subscribe

        subscribe.apply(this, arguments)

        this.subscribe(() => {}) // Keep it active forever.
      }
    }

    return maybeInactive
  }
}

module.exports = dc
