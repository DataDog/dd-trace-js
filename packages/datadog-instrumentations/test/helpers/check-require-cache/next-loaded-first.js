#!/usr/bin/env node
'use strict'

const path = require('node:path')
const Module = require('node:module')

// Reproduce the `instrumentation.ts` ordering trap from issues #5430 / #5432:
// Next.js loads its own server before the tracer initializes. The detector only
// reads require.cache keys, so a synthetic entry recreates that runtime state
// without building and running a real Next.js app.
const nextServer = path.join(__dirname, 'node_modules', 'next', 'dist', 'server', 'next-server.js')
const fakeModule = new Module(nextServer)
fakeModule.exports = {}
fakeModule.loaded = true
require.cache[nextServer] = fakeModule

const tracer = require('../../../../../')
tracer.init()

process.exit()
