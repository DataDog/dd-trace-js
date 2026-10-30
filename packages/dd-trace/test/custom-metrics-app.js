#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

console.log('demo app started')

const tracer = require('../../../').init()

tracer.dogstatsd.increment('page.views.data')

if (process.env.MOCK_GLOBAL_URL === 'true') {
  Object.defineProperty(globalThis, 'URL', { value: () => {}, configurable: true, writable: true })
}

console.log('demo app finished')
