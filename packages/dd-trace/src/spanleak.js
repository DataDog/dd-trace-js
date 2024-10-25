'use strict'

/* eslint-disable no-console */

const SortedSet = require('tlhunter-sorted-set')

const INTERVAL = 1000 // look for expired spans every 1s
const LIFETIME = 60 * 1000 // all spans have a max lifetime of 1m

const MODES = {
  DISABLED: 0,
  // METRICS_ONLY
  LOG: 1,
  GC_AND_LOG: 2
  // GC
}

module.exports.MODES = MODES

const spans = new SortedSet()

// TODO: should these also be delivered as runtime metrics?

// const registry = new FinalizationRegistry(name => {
//   spans.del(span) // there is no span
// })

let interval
let mode = MODES.DISABLED

module.exports.disable = function () {
  mode = MODES.DISABLED
}

module.exports.enableLogging = function () {
  mode = MODES.LOG
}

module.exports.enableGarbageCollection = function () {
  mode = MODES.GC_AND_LOG
}

module.exports.startScrubber = function () {
  if (!isEnabled()) return

  interval = setInterval(() => {
    const now = Date.now()
    const expired = spans.rangeByScore(0, now)

    if (!expired.length) return

    const gc = isGarbageCollecting()

    const expirationsByType = Object.create(null) // { [spanType]: count }

    for (const wrapped of expired) {
      spans.del(wrapped)
      const span = wrapped.deref()

      if (!span) continue // span has already been garbage collected

      // TODO: Should we also do things like record the route to help users debug leaks?
      if (!expirationsByType[span._name]) expirationsByType[span._name] = 0
      expirationsByType[span._name]++

      if (!gc) continue // everything after this point is related to manual GC

      // TODO: what else can we do to alleviate memory usage
      span.context()._tags = Object.create(null)
    }

    console.log('expired spans:' +
      Object.keys(expirationsByType).reduce((a, c) => `${a} ${c}: ${expirationsByType[c]}`, ''))
  }, INTERVAL)
}

module.exports.stopScrubber = function () {
  clearInterval(interval)
}

module.exports.addSpan = function (span) {
  if (!isEnabled()) return

  const now = Date.now()
  const expiration = now + LIFETIME
  // eslint-disable-next-line no-undef
  const wrapped = new WeakRef(span)
  spans.add(wrapped, expiration)
  // registry.register(span, span._name)
}

function isEnabled () {
  return mode > MODES.DISABLED
}

function isGarbageCollecting () {
  return mode >= MODES.GC_AND_LOG
}
