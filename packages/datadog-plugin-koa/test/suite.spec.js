'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe('koa test suite', () => {
    suiteTest('koa', 'koajs/koa', 'latest')
  })
})

describe('Plugin', () => {
  describe('@koa/router test suite', () => {
    suiteTest('@koa/router', 'koajs/router', 'latest')
  })
})
