#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const assert = require('assert')
const webpack = require('webpack')
const DatadogWebpackPlugin = require('../../webpack') // dd-trace/webpack

const OUTFILE = path.join(__dirname, 'git-tags-out.js')

const compiler = webpack({
  mode: 'development',
  entry: path.join(__dirname, 'basic-test.js'),
  target: 'node',
  externalsType: 'commonjs',
  output: {
    filename: 'git-tags-out.js',
    path: __dirname,
    hashFunction: 'sha256',
  },
  externals: [
    // Node built-in not in webpack's default list for target: 'node'
    'diagnostics_channel',
    // dead code paths introduced by knex
    'pg',
    'mysql2',
    'better-sqlite3',
    'sqlite3',
    'mysql',
    'oracledb',
    'pg-query-stream',
    'tedious',
    '@yaacovcr/transform',
    // optional native dd-trace modules
    '@datadog/native-appsec',
    '@datadog/native-iast-taint-tracking',
    '@datadog/native-metrics',
    '@datadog/pprof',
    '@datadog/libdatadog',
  ],
  plugins: [
    new DatadogWebpackPlugin(),
  ],
})

compiler.run((err, stats) => {
  try {
    if (err) {
      console.error(err)
      process.exitCode = 1
      return
    }
    if (stats.hasErrors()) {
      console.error(stats.toString({ errors: true }))
      process.exitCode = 1
      return
    }

    const { status, stdout, stderr } = spawnSync('node', [OUTFILE], {
      env: { ...process.env, DD_TRACE_DEBUG: 'true' },
      encoding: 'utf8',
    })
    if (stderr.length) {
      console.error(stderr)
    }
    if (status) {
      throw new Error(`Generated script exited with unexpected exit code: ${status}`)
    }
    if (stdout.length === 0) {
      throw new Error('No debug output received. Git metadata may not be injected properly')
    }
    const repositoryURL = stdout.match(/"_dd\.git\.repository_url":"([^"]+)"/)?.[1]
    const commitSha = stdout.match(/"_dd\.git\.commit\.sha":"([^"]+)"/)?.[1]
    assert.ok(repositoryURL, '_dd.git.repository_url should be present')
    assert.ok(commitSha, '_dd.git.commit.sha should be present')
    assert.equal(commitSha.length, 40, 'Git commit sha tag should be valid')
    console.log('ok')
  } catch (e) {
    console.error(e)
    process.exitCode = 1
  } finally {
    fs.rmSync(OUTFILE, { force: true })
  }
})
