'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

suiteTest('koa', 'koajs/koa', 'latest')

// TODO enable this
// suiteTest('@koa/router', 'koajs/router', 'latest')
