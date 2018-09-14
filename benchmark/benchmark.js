'use strict'

/* eslint-disable no-console */

const Benchmark = require('benchmark')

Benchmark.options.maxTime = 0.1
Benchmark.options.minSamples = 5

module.exports = title => {
  const suite = new Benchmark.Suite()

  return suite
    .on('start', event => {
      console.log(`\n=== ${title} ===\n`)
    })
    .on('cycle', event => {
      console.log(String(event.target))
    })
    .on('error', event => {
      console.log(String(event.target.error))
    })
}
