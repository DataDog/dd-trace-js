#!/usr/bin/env node

const ddPlugin = require('../../esbuild') // dd-trace/esbuild
const esbuild = require('esbuild')

esbuild.build({
  entryPoints: ['basic-test.js'],
  bundle: true,
  outfile: 'out.js',
  plugins: [ddPlugin],
  platform: 'node',
  target: ['node16']
}).catch((err) => {
  console.error(err) // eslint-disable-line no-console
  process.exit(1)
})
