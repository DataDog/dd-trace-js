'use strict'

const benchmark = require('../benchmark')
const platform = require('../../packages/dd-trace/src/platform')
const Config = require('../../packages/dd-trace/src/config')

const suite = benchmark('platform (node)')

const config = new Config()

platform.configure(config)

suite
  .add('now', {
    fn () {
      platform.now()
    }
  })

suite.run()
