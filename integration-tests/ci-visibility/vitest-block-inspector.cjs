'use strict'

const inspector = require('node:inspector')

if (process.env.VITEST_INSPECTOR_FAILURE === 'connect') {
  inspector.Session.prototype.connect = function () {
    throw new Error('Inspector disabled for testing')
  }
} else {
  const post = inspector.Session.prototype.post
  inspector.Session.prototype.post = function (method) {
    if (method === 'Profiler.takePreciseCoverage') {
      const callback = arguments[arguments.length - 1]
      callback(new Error('Inspector coverage collection disabled for testing'))
      return
    }
    return post.apply(this, arguments)
  }
}
