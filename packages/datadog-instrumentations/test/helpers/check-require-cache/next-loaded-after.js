#!/usr/bin/env node
'use strict'

const Module = require('node:module')
const path = require('node:path')

const tracer = require('../../../../../')
tracer.init()

// Next.js loads its server after the tracer is initialized (the supported
// order). The detector runs during init, so injecting the cache entry now must
// not produce a warning.
const nextServer = path.join(__dirname, 'node_modules', 'next', 'dist', 'server', 'next-server.js')
const fakeModule = new Module(nextServer)
fakeModule.exports = {}
fakeModule.loaded = true
require.cache[nextServer] = fakeModule

process.exit()
