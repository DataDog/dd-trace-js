#!/usr/bin/env node

import fs from 'fs/promises'
import assert from 'assert'

import * as esbuild from 'esbuild'

import versions from '../../version.js'
import ddPlugin from '../../esbuild.js'

const { NODE_MAJOR } = versions

try {
  await esbuild.build({
    entryPoints: ['./koa.mjs'],
    bundle: true,
    outfile: './outfile.js',
    minify: false,
    sourcemap: false,
    platform: 'node',
    target: 'es2022',
    plugins: [ddPlugin],
    external: [
      'graphql/language/visitor',
      'graphql/language/printer',
      'graphql/utilities'
    ]
  })

  // Verify instrumentation
  const data = await fs.readFile('./outfile.js', 'utf8')

  if (NODE_MAJOR >= 22) {
    // it is resolved as ESM module only in node 22+, becaues the require.resolve accepts conditions in node 22+
    assert.match(data, /register.*koa.mjs".*"koa"\);$/m, 'Bundle should contain the koa ESM instrumentation')
  } else {
    assert.match(data, /^ {8}package: "koa",$/m, 'Bundle should contain the koa CJS instrumentation')
  }
  assert.match(data, /^ {8}package: "@koa\/router",$/m, 'Bundle should contain the @koa/router instrumentation')

  console.log('ok') // eslint-disable-line no-console
} finally {
  await fs.rm('./outfile.js', { force: true })
}
