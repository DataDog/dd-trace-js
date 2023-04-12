'use strict'

const {
  Channel,
  channel,
  hasSubscribers
} = require('diagnostics_channel')

const [major, minor] = process.versions.node.split('.')

// Our own DC with a limited subset of functionality stable across Node versions.
// TODO: Move the rest of the polyfill here.
// TODO: Switch to using global subscribe/unsubscribe.
const dc = { channel, hasSubscribers }

// Prevent going to 0 subscribers to avoid bug in Node.
// See https://github.com/nodejs/node/pull/47520
if (major === '19' && minor === '9') {
  const channel = dc.channel

  dc.channel = function () {
    const maybeInactive = channel.apply(this, arguments)

    if (maybeInactive.subscribe === Channel.prototype.subscribe) {
      maybeInactive.subscribe = function () {
        const active = this.subscribe.apply(this, arguments)

        active.subscribe(() => {}) // Keep it active forever.
      }
    }

    return maybeInactive
  }
}

module.exports = dc
