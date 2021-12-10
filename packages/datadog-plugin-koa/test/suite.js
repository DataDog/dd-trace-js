'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

suiteTest({
  modName: 'koa',
  repoUrl: 'koajs/koa',
  commitish: 'latest',
  parallel: false
})

// TODO enable this
// suiteTest('@koa/router', 'koajs/router', 'latest')
