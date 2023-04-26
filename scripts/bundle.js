'use strict'

const esbuild = require('esbuild')
const { nodeExternalsPlugin } = require('esbuild-node-externals')

esbuild.build({
  logLevel: 'info',
  entryPoints: ['index-src.js'],
  bundle: true,
  minify: true,
  platform: 'node',
  outfile: 'index.js',
  plugins: [nodeExternalsPlugin()]
})
