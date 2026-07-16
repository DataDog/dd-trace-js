#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

const path = require('node:path')

const esbuild = require('esbuild')
const ddPlugin = require('dd-trace/esbuild.js')

const entryPoint = path.join(__dirname, 'durable-execution.js')
const outfile = path.join(__dirname, 'durable-execution-out.js')

const external = [
  // dd-trace optional native dependencies, kept external when bundling dd-trace.
  '@datadog/native-metrics',
  '@datadog/pprof',
  '@datadog/native-appsec',
  '@datadog/native-iast-taint-tracking',
  '@datadog/native-iast-rewriter',
  '@openfeature/server-sdk',
]

// DD_EXTERNAL=1 keeps the durable SDK out of the bundle so it is required at runtime,
// where dd-trace instruments it (Orchestrion rewriting + the worker-based test runner).
if (process.env.DD_EXTERNAL) {
  external.push('@aws/durable-execution-sdk-js', '@aws/durable-execution-sdk-js-testing')
}

esbuild.build({
  entryPoints: [entryPoint],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  plugins: [ddPlugin],
  external,
}).then(() => {
  console.log('build ok')
}).catch((err) => {
  console.error(err)
  process.exit(1)
})
