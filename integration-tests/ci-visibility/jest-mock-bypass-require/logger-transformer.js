'use strict'

const path = require('node:path')

module.exports = {
  process (sourceText, sourcePath) {
    const loggerPathSegment = `${path.sep}node_modules${path.sep}${process.env.TEST_LOGGER}${path.sep}`
    const transformedSource = sourcePath.includes(loggerPathSegment)
      ? `${sourceText}\nmodule.exports.ddJestTransformed = true\n`
      : sourceText

    return { code: transformedSource }
  },
}
