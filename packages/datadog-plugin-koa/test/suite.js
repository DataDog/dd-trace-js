'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

// TODO: Temporarily limiting this to run against v2.15.3 instead of `latest`,
// as it's currently failing on `latest` because that code hasn't been pushed to GitHub.
// For details, see: https://github.com/koajs/koa/issues/1857
suiteTest('koa', 'koajs/koa', '2.15.3')

// TODO enable this
// suiteTest('@koa/router', 'koajs/router', 'latest')
