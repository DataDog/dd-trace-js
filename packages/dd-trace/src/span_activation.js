'use strict'

const { storage } = require('../../datadog-core')
const { channel } = require('dc-polyfill')

const spanActivatedChannel = channel('dd-trace:span:activate')

// TODO: refactor bind to use shimmer once the new internal tracer lands

const originals = new WeakMap()

function activeSpan () {
  return storage('legacy').getStore()?.span
}

function activateSpan(store, span) {
  storage('legacy').enterWith({ ...store, span })
  spanActivatedChannel.publish(span)
}

function runWithSpan (span, callback) {
  if (typeof callback !== 'function') return callback

  const legacyStorage = storage('legacy')
  const oldStore = legacyStorage.getStore()
  const newStore = span ? legacyStorage.getStore(span._store) : oldStore

  activateSpan(newStore, span)

  try {
    return callback()
  } catch (e) {
    if (span && typeof span.setTag === 'function') {
      span.setTag('error', e)
    }

    throw e
  } finally {
    legacyStorage.enterWith(oldStore)
  }
}

function bindToSpan (fn, span) {
  if (typeof fn !== 'function') return fn

  const spanOrActive = span ?? activeSpan()

  const bound = function () {
    return runWithSpan(spanOrActive, () => {
      return fn.apply(this, arguments)
    })
  }

  originals.set(bound, fn)

  return bound
}

module.exports = {
  activeSpan,
  activateSpan,
  bindToSpan,
  runWithSpan,
  spanActivatedChannel
}
