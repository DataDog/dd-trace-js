#!/usr/bin/env node

const ddPlugin = require('../../esbuild') // dd-trace/esbuild
const esbuild = require('esbuild')

const commonConfig = {
  format: 'esm',
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
  ]
}

esbuild.build(commonConfig).catch((err) => {
  console.error(err) // eslint-disable-line no-console
  process.exit(1)
})

esbuild.build({
  ...commonConfig,
  banner: {
    js: '/* js test */'
  },
  outfile: 'out-with-unrelated-js-banner.mjs'
}).catch((err) => {
  console.error(err) // eslint-disable-line no-console
  process.exit(1)
})

esbuild.build({
  ...commonConfig,
  banner: {
    js: `import { createRequire } from 'module';
import { fileURLToPath  } from 'url';
import { dirname } from 'path';
globalThis.require ??= createRequire(import.meta.url);
globalThis.__filename ??= fileURLToPath(import.meta.url);
globalThis.__dirname ??= dirname(globalThis.__filename);`
  },
  outfile: 'out-with-patched-global-banner.mjs'
}).catch((err) => {
  console.error(err) // eslint-disable-line no-console
  process.exit(1)
})

esbuild.build({
  ...commonConfig,
  banner: {
    js: `import { createRequire } from 'module';
import { fileURLToPath  } from 'url';
import { dirname } from 'path';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);`
  },
  outfile: 'out-with-patched-const-banner.mjs'
}).catch((err) => {
  console.error(err) // eslint-disable-line no-console
  process.exit(1)
})

esbuild.build({
  ...commonConfig,
  outfile: 'out-relying-in-extension.mjs',
  format: undefined
}).catch((err) => {
  console.error(err) // eslint-disable-line no-console
  process.exit(1)
})

esbuild.build({
  ...commonConfig,
  outfile: 'out.js'
}).catch((err) => {
  console.error(err) // eslint-disable-line no-console
  process.exit(1)
})

// output => basic-test.mjs
esbuild.build({
  ...commonConfig,
  outfile: undefined,
  format: undefined,
  outdir: './',
  outExtension: { '.js': '.mjs' }
}).catch((err) => {
  console.error(err) // eslint-disable-line no-console
  process.exit(1)
})

esbuild.build({
  ...commonConfig,
  outfile: 'out-non-esm.js',
  format: undefined
}).catch((err) => {
  console.error(err) // eslint-disable-line no-console
  process.exit(1)
})
