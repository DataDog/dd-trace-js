'use strict'

require('../src/when')

const assertPromise = require('./helpers/promise')

assertPromise('when', when => {
  return function Promise (executor) {
    const deferred = when.defer()

    executor(deferred.resolve, deferred.reject)

    return deferred.promise
  }
})
