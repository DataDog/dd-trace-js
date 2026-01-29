'use strict'

const { rspack } = require('@rspack/core')
const config = require('./rspack.config')

rspack(config, (err, stats) => {
  if (err) {
    console.error(err)
    if (err.details) {
      console.error(err.details)
    }
    process.exit(1)
  }

  const info = stats.toJson()

  if (stats.hasWarnings()) {
    console.warn(info.warnings)
  }

  if (stats.hasErrors()) {
    console.error(info.errors)
    process.exit(1)
  }
})
