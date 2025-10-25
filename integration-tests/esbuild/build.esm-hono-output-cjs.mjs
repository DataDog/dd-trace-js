#!/usr/bin/env node

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import esbuild from 'esbuild'

import ddPlugin from 'dd-trace/esbuild.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(__dirname, 'hono-out.cjs')

const entryPoint = path.join(__dirname, 'hono.mjs')
const external = [
  // required if you use native metrics
  '@datadog/native-metrics',

  // required if you use profiling
  '@datadog/pprof',

  // @openfeature/core is a peer dependency of @openfeature/server-sdk
  // which is used by @datadog/openfeature-node-server
  '@openfeature/core',

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
  format: 'cjs',
  external
})
