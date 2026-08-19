'use strict'

const esbuild = require('esbuild')

esbuild.buildSync({
  entryPoints: ['esbuild/ai-v7-app.js'],
  outfile: 'esbuild/ai-v7-out.cjs',
  bundle: true,
  external: ['dd-trace'],
  format: 'cjs',
  platform: 'node',
  target: 'node22',
})
