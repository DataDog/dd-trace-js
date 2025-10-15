'use strict'

/* eslint-disable no-console */

const esbuild = require('esbuild')

const esbuildCommonConfig = require('./esbuild.common-config')

esbuild.build({
  ...esbuildCommonConfig,
  outfile: 'build/iast-disabled.js',
  sourcemap: false
}).catch((err) => {
  console.error(err)
  process.exit(1)
})
