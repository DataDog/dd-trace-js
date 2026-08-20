'use strict'

/* eslint-disable no-console */

const { channel } = require('dc-polyfill')
const SortedSet = require('../../../vendor/dist/tlhunter-sorted-set')
const eventWriter = require('./opentracing/event-writer')

const INTERVAL = 1000 // look for expired spans every 1s
const LIFETIME = 60 * 1000 // all spans have a max lifetime of 1m

const MODES = {
  DISABLED: 0,
  // METRICS_ONLY
  LOG: 1,
  GC_AND_LOG: 2,
  // GC
}

module.exports.MODES = MODES

const spans = new SortedSet()
const spanNames = new WeakMap()
const spanStartedCh = channel('dd-trace:span:event-writer:span-started')

// TODO: should these also be delivered as runtime metrics?

// const registry = new FinalizationRegistry(name => {
//   spans.del(span) // there is no span
// })

let interval
let mode = MODES.DISABLED
let subscribed = false

module.exports.disable = function () {
  mode = MODES.DISABLED
  if (subscribed) {
    spanStartedCh.unsubscribe(onSpanStarted)
    subscribed = false
  }
}

module.exports.enableLogging = function () {
  mode = MODES.LOG
  subscribeToSpanStarts()
}

module.exports.enableGarbageCollection = function () {
  mode = MODES.GC_AND_LOG
  subscribeToSpanStarts()
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
      const name = spanNames.get(span) || 'unknown'
      if (!expirationsByType[name]) expirationsByType[name] = 0
      expirationsByType[name]++

      if (!gc) continue // everything after this point is related to manual GC

      // TODO: what else can we do to alleviate memory usage
      eventWriter.clearTags(span)
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
  const wrapped = new WeakRef(span)
  spans.add(wrapped, expiration)
}

function isEnabled () {
  return mode > MODES.DISABLED
}

function isGarbageCollecting () {
  return mode >= MODES.GC_AND_LOG
}

function subscribeToSpanStarts () {
  if (subscribed) return
  spanStartedCh.subscribe(onSpanStarted)
  subscribed = true
}

function onSpanStarted ({ span, operationName }) {
  spanNames.set(span, operationName)
}
