#!/usr/bin/env node

const esbuild = require('esbuild')

const commonConfig = require('./build.esm.common-config')

esbuild.build(commonConfig).catch((err) => {
  console.error(err) // eslint-disable-line no-console
  process.exit(1)
})
