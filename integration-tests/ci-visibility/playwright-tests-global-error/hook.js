'use strict'

module.exports = function () {
  throw new Error(`Synthetic ${process.env.PLAYWRIGHT_GLOBAL_ERROR_MODE} failure`)
}
