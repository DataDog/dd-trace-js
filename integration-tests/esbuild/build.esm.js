#!/usr/bin/env node

const ddPlugin = require('../../esbuild') // dd-trace/esbuild
const esbuild = require('esbuild')

esbuild.build({
  format: "esm",
  entryPoints: ['basic-test.js'],
  bundle: true,
  outfile: 'out.mjs',
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
  ],
  banner: {
    js: `import { createRequire } from 'module';const require = createRequire(import.meta.url);`,
  }
}).catch((err) => {
  console.error(err) // eslint-disable-line no-console
  process.exit(1)
})
