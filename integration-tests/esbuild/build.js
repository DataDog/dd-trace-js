#!/usr/bin/env node
'use strict'

const esbuild = require('esbuild')
const ddPlugin = require('../../esbuild') // dd-trace/esbuild

esbuild.build({
  entryPoints: ['basic-test.js'],
  bundle: true,
  outfile: 'out.js',
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
    'tedious',
    '@yaacovcr/transform'
  ]
}).catch((err) => {
  console.error(err) // eslint-disable-line no-console
  process.exit(1)
})
