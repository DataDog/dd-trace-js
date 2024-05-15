'use strict'

const dc = require('dc-polyfill')
const coalesce = require('koalas')
const profileSubmittedChannel = dc.channel('datadog:profiling:mock-profile-submitted')
const { DD_PROFILING_UPLOAD_PERIOD } = process.env

let timerId

module.exports = {
  start: config => {
    // Copied from packages/dd-trace/src/profiler.js
    const flushInterval = coalesce(config.interval, Number(DD_PROFILING_UPLOAD_PERIOD) * 1000, 65 * 1000)

    timerId = setTimeout(() => {
      profileSubmittedChannel.publish()
      timerId.refresh()
    }, flushInterval)
    timerId.unref()
  },

  stop: () => {
    if (timerId !== undefined) {
      clearTimeout(timerId)
      timerId = undefined
    }
  }
}
