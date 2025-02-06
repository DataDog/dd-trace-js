#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

console.log('demo app started')

const tracer = require('../../../').init()

tracer.dogstatsd.increment('page.views.data')

console.log('demo app finished')
