'use strict'

module.exports = ({ a, b }) => {
  return {
    sum: a + b,
    ddVitestWorker: process.env.DD_VITEST_WORKER,
  }
}
