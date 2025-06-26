'use strict'

const { addHook, channel } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const { getTestSuitePath } = require('../../dd-trace/src/plugins/util/test')

const testStartCh = channel('ci:node-test:test:start')
const testFinishCh = channel('ci:node-test:test:finish')

addHook({
  name: 'node:test',
}, (testModule, frameworkVersion) => {
  shimmer.wrap(testModule, 'test', test => function (name, options, fn) {
    const testContext = {
      name,
      suite: getTestSuitePath(__filename, process.cwd()),
      frameworkVersion,
      testSourceFile: __filename,
    }

    let result
    testStartCh.runStores(testContext, () => {
      result = test.apply(this, arguments)
      testFinishCh.publish({
        ...testContext.currentStore,
        status: 'pass'
      })
    })
    return result
  })

  return testModule
})
