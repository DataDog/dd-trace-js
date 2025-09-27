#!/usr/bin/env node

import ddPlugin from 'dd-trace/esbuild.js'

import esbuild from 'esbuild'
import path from 'path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(__dirname, 'esm-http-test-out.mjs')
const entryPoint = path.join(__dirname, 'esm-http-test.mjs')

const external = [
  // required if you use native metrics
  '@datadog/native-metrics',

  // required if you use profiling
  '@datadog/pprof',

  // required if you use Datadog security features
  '@datadog/native-appsec',
  '@datadog/native-iast-taint-tracking',
  '@datadog/native-iast-rewriter',

  // required if you encounter graphql errors during the build step
  'graphql/language/visitor',
  'graphql/language/printer',
  'graphql/utilities',
]

esbuild.build({
  entryPoints: [entryPoint],
  outfile: SCRIPT,
  minify: false,
  bundle: true,
  platform: 'node',
  target: 'node22',
  plugins: [ddPlugin],
  format: 'esm',
  external
}).catch((err) => {
  process.exit(1)
})
