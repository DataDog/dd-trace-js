#!/usr/bin/env node
'use strict'

const Module = require('node:module')
const path = require('node:path')

// Only a non-server next file is cached before the tracer. The server module is
// what the next plugin hooks, so loading a utility first must not warn — the
// server can still load (and be instrumented) after init.
const nextUtil = path.join(__dirname, 'node_modules', 'next', 'constants.js')
const fakeModule = new Module(nextUtil)
fakeModule.exports = {}
fakeModule.loaded = true
require.cache[nextUtil] = fakeModule

const tracer = require('../../../../../')
tracer.init()

process.exit()
