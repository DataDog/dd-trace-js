#!/usr/bin/env node

const ddPlugin = require('dd-trace/esbuild')
const esbuild = require('esbuild')

esbuild.build({
  entryPoints: ['app.mjs'],
  bundle: true,
  outfile: 'out.js',
  plugins: [ddPlugin],
  external: [
    'pg-native', // peer dep
    'graphql/language/visitor',
    'graphql/language/printer',
    'graphql/utilities'
  ],
  platform: 'node',
  target: ['node16']
}).catch((err) => {
  console.error(err) // eslint-disable-line no-console
  process.exit(1)
})
