#!/usr/bin/env node

import fs from 'fs'

import * as esbuild from 'esbuild'

import ddPlugin from '../../esbuild.js'

try {
  await esbuild.build({
    entryPoints: ['typescript-app.ts'],
    bundle: true,
    outfile: 'typescript-app-out.js',
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
  console.log('ok') // eslint-disable-line no-console
} finally {
  fs.rmSync('typescript-app-out.js', { force: true })
}
