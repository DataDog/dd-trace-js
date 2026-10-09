'use strict'

const path = require('node:path')

const { describe } = require('mocha')

const { testSpanLeakFixture } = require('./span-leak-detector-process')

const fixture = path.join(__dirname, '../fixtures/span-leak-detector.js')

describe('span-leak detector Mocha lifecycle', () => {
  testSpanLeakFixture('a global reference', fixture, /child_process\/command_execution \[1\]/)
})
