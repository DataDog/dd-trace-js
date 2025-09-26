#!/usr/bin/env node
'use strict'

const ddPlugin = require('../../esbuild') // dd-trace/esbuild
const esbuild = require('esbuild')
const fs = require('fs')
const { execFile, spawnSync, spawn } = require('child_process')
const SCRIPT = __dirname + '/hono-out.mjs'

const entryPoint = __dirname + '/hono.js'
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
];
esbuild.build({
  entryPoints: [entryPoint],
  outfile: SCRIPT,
  minify: false,
  bundle: true,
  loader: { '.ts': 'ts' },
  platform: 'node',
  target: 'node22',
  plugins: [ddPlugin],
  format: 'esm',
  //format: 'cjs',
  external
}).then(() => {
  console.log('::::: BUILD COMPLETED :::::')
  // process.env.DD_TRACE_DEBUG = 'true'
  try {
    // const data = spawn('node', [SCRIPT], { env: { ...process.env, DD_TRACE_DEBUG: 'true' }})
    // data.stdout?.on('data', (data) => {
    //   console.log(data.toString())
    // })
    // data.stderr?.on('data', (data) => {
    //   console.error(data.toString())
    // })
    // data.on('close', (code) => {
    //   console.log(`Child process exited with code ${code}`)
    // })
    // console.log(data.stdout?.toString())
    // console.error(data.stderr?.toString())
  } catch (error) {
    console.error(error)
    throw error
  }
}).catch((err) => {
  console.error(err)
  process.exit(1)
}).finally(() => {
//  fs.rmSync(SCRIPT, { force: true })
})