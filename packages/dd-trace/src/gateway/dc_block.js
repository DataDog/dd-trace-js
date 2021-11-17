'use strict'

const dc = require('diagnostics_channel')
const shimmer = require('shimmer')

let protoCache

function getActiveChannelPrototype () {
  if (protoCache) return protoCache

  const noop = () => {}

  const channel = dc.channel('dd-trace:temp_getproto')

  // We have to force the channel to switch to ActiveChannel prototype
  channel.subscribe(noop)

  const activeChannelPrototype = Object.getPrototypeOf(channel)

  channel.unsubscribe(noop)

  protoCache = activeChannelPrototype

  return activeChannelPrototype
}

function blockingPublish (data) {
  let firstError

  for (let i = 0; i < this._subscribers.length; i++) {
    try {
      const onMessage = this._subscribers[i]
      onMessage(data, this.name)
    } catch (err) {
      if (firstError === undefined && err instanceof DCBlockingError) {
        firstError = err
      } else {
        process.nextTick(() => {
          throw err
        })
      }
    }
  }

  if (firstError) throw firstError
}

function enable () {
  shimmer.wrap(getActiveChannelPrototype(), 'publish', (originalPublish) => {
    return blockingPublish
  })
}

function disable () {
  shimmer.unwrap(getActiveChannelPrototype(), 'publish')
}

class DCBlockingError extends Error {
  constructor (message) {
    super(message)
    this.name = this.constructor.name
  }
}

module.exports = {
  enable,
  disable,
  DCBlockingError
}
