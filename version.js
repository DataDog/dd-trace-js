'use strict'

const matches = require('./package.json').version.match(/^(\d+)\.(\d+)\.(\d+)/)

module.exports = {
  MAJOR: parseInt(matches[1]),
  MINOR: parseInt(matches[2]),
  PATCH: parseInt(matches[3])
}
