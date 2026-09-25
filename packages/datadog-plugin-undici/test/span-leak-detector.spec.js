'use strict'

const path = require('node:path')

const { describe } = require('mocha')

const { testSpanLeakFixture } = require('../../dd-trace/test/plugins/span-leak-detector-process')

const fixture = path.join(__dirname, 'fixtures/span-leak-detector.js')

describe('Undici span leak detector integration proof', () => {
  testSpanLeakFixture('async-context retention', fixture, /undici\/undici\.request \[1\]/)
})
