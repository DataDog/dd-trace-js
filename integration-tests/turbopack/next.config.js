'use strict'

const path = require('node:path')
const { withDatadogTurbopack } = require('dd-trace/turbopack')

module.exports = async () => {
  const root = path.dirname(__dirname)

  return {
    turbopack: await withDatadogTurbopack({ root }, root),
  }
}
