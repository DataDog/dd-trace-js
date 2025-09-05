#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */
const fs = require('fs')
const { spawnSync } = require('child_process')
const assert = require('assert')

const ddPlugin = require('../../esbuild') // dd-trace/esbuild
const esbuild = require('esbuild')

const SCRIPT = './git-tags-out.js'

esbuild.build({
  entryPoints: ['basic-test.js'],
  bundle: true,
  outfile: SCRIPT,
  plugins: [ddPlugin],
  platform: 'node',
  target: ['node18'],
  external: [
    // dead code paths introduced by knex
    'pg',
    'mysql2',
    'better-sqlite3',
    'sqlite3',
    'mysql',
    'oracledb',
    'pg-query-stream',
    'tedious'
  ]
}).then(() => {
  const { status, stdout, stderr } = spawnSync('node', [SCRIPT], {
    env: { ...process.env, DD_TRACE_DEBUG: 'true' }
  })
  if (stdout.length) {
    console.log(stdout.toString())
    const output = stdout.toString()
    const repositoryURL = output.match(/"_dd\.git\.repository_url":"([^"]+)"/)?.[1]
    const commitSha = output.match(/"_dd\.git\.commit\.sha":"([^"]+)"/)?.[1]
    assert.ok(repositoryURL, '_dd.git.repository_url should be present')
    assert.ok(commitSha, '_dd.git.commit.sha should be present')
    assert.ok(commitSha.length === 40, 'Git commit sha tag should be valid')
  }
  if (stderr.length) {
    console.error(stderr.toString())
  }
  if (status) {
    throw new Error('generated script failed to run')
  }
  console.log('ok')
}).catch((err) => {
  console.error(err)
  process.exit(1)
}).finally(() => {
  fs.rmSync(SCRIPT, { force: true })
})
