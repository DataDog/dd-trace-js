'use strict'

const benchmark = require('./benchmark')
const proxyquire = require('proxyquire')
const { createSingleExposureEvent, createExposureEventArray } = require('./stubs/exposure-events')

const Config = require('../packages/dd-trace/src/config')
const ExposuresWriter = proxyquire('../packages/dd-trace/src/openfeature/writers/exposures', {
  '../../exporters/common/request': () => {}
})

const config = new Config({ service: 'benchmark', version: '1.0.0', env: 'test' })
const suite = benchmark('openfeature')

let writer
let singleEvent
let eventArray

suite
  .add('ExposuresWriter#append (single event)', {
    onStart () {
      writer = new ExposuresWriter(config)
      writer.setEnabled(true)
      singleEvent = createSingleExposureEvent()
    },
    fn () {
      writer.append(singleEvent)
    }
  })
  .add('ExposuresWriter#append (event array)', {
    onStart () {
      writer = new ExposuresWriter(config)
      writer.setEnabled(true)
      eventArray = createExposureEventArray(10)
    },
    fn () {
      writer.append(eventArray)
    }
  })
  .add('ExposuresWriter#append (disabled, single event)', {
    onStart () {
      writer = new ExposuresWriter(config)
      writer.setEnabled(false)
      singleEvent = createSingleExposureEvent()
    },
    fn () {
      writer.append(singleEvent)
      // Clear buffer periodically to prevent unbounded growth during benchmarking
      if (writer._pendingEvents.length >= 1000) {
        writer._pendingEvents = []
      }
    }
  })
  .add('ExposuresWriter#append (disabled, event array)', {
    onStart () {
      writer = new ExposuresWriter(config)
      writer.setEnabled(false)
      eventArray = createExposureEventArray(10)
    },
    fn () {
      writer.append(eventArray)
      // Clear buffer periodically to prevent unbounded growth during benchmarking
      if (writer._pendingEvents.length >= 1000) {
        writer._pendingEvents = []
      }
    }
  })
  .add('ExposuresWriter#makePayload', {
    onStart () {
      writer = new ExposuresWriter(config)
      eventArray = createExposureEventArray(100)
    },
    fn () {
      writer.makePayload(eventArray)
    }
  })

suite.run()
