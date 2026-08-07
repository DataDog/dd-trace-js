'use strict'

module.exports = function ThrowingReporter (runner) {
  runner.on('end', () => {
    throw new Error('custom Mocha reporter failed')
  })
}
