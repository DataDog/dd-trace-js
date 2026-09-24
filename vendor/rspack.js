'use strict'

const { rspack } = require('@rspack/core')
const config = require('./rspack.config')

rspack(config, (error, stats) => {
  if (error) {
    console.error(error)
    if (error.details) {
      console.error(error.details)
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
