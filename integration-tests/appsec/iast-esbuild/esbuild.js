'use strict'

/* eslint-disable no-console */

const esbuild = require('esbuild')

const esbuildCommonConfig = require('./esbuild.common-config')

esbuild.build({
  ...esbuildCommonConfig,
  outfile: 'build/iast-enabled-with-sm.js',
  sourcemap: true,
  define: {
    __DD_IAST_ENABLED__: 'true'
  },
}).catch((err) => {
  console.error(err)
  process.exit(1)
})

esbuild.build({
  ...esbuildCommonConfig,
  outfile: 'build/iast-enabled-with-no-sm.js',
  sourcemap: false,
  define: {
    __DD_IAST_ENABLED__: 'true'
  },
}).catch((err) => {
  console.error(err)
  process.exit(1)
})

esbuild.build({
  ...esbuildCommonConfig,
  outfile: 'build/iast-disabled.js',
  sourcemap: false
}).catch((err) => {
  console.error(err)
  process.exit(1)
})
