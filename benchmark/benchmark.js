'use strict'

/* eslint-disable no-console */

const Benchmark = require('benchmark')
const nock = require('nock')

Benchmark.options.maxTime = 0
Benchmark.options.minSamples = 100

nock.disableNetConnect()

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
      throw event.target.error
    })
}
