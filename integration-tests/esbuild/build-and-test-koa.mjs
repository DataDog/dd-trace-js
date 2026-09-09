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
    external: [],
  })

  // Verify instrumentation
  const data = await fs.readFile('./outfile.js', 'utf8')

  if (NODE_MAJOR >= 22) {
    // It resolves as ESM only in Node.js 22+, where require.resolve accepts conditions.
    assert.match(
      data,
      /registerWithData.*koa\.mjs".*"koa".*\{ "moduleName": "koa"/,
      'Bundle should contain the koa ESM instrumentation'
    )
    assert.match(
      data,
      /registerWithData.*@koa\/router[^\n\r"\u2028\u2029]*".*"@koa\/router".*"moduleName": "@koa\/router"/,
      'Bundle should contain the @koa/router instrumentation'
    )
  } else {
    assert.match(
      data,
      /registerCommonJS.*"koa".*\{ "moduleName": "koa"/,
      'Bundle should contain the koa CJS instrumentation'
    )
    assert.match(
      data,
      /registerCommonJS.*"@koa\/router".*\{ "moduleName": "@koa\/router"/,
      'Bundle should contain the @koa/router CJS instrumentation'
    )
  }

  console.log('ok') // eslint-disable-line no-console
} finally {
  await fs.rm('./outfile.js', { force: true })
}
