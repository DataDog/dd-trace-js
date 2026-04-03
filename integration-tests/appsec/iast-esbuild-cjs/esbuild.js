'use strict'

/* eslint-disable no-console */

const esbuild = require('esbuild')

const esbuildCommonConfig = require('./esbuild.common-config')

esbuild.build({
  ...esbuildCommonConfig,
  outfile: 'build/iast-enabled-with-sm.js',
  sourcemap: true,
}).catch((err) => {
  console.error(err)
  process.exit(1)
})

esbuild.build({
  ...esbuildCommonConfig,
  outfile: 'build/iast-enabled-with-no-sm.js',
  sourcemap: false,
}).catch((err) => {
  console.error(err)
  process.exit(1)
})
