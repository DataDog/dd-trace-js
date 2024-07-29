'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const dc = require('dc-polyfill')

describe('azure functions', () => {
  const modules = ['azure-functions']

  const azureFunctionsChannel = dc.tracingChannel('datadog:azure-functions:http')// ***

  modules.forEach((moduleName) => {
    describe(moduleName, () => {
      let start, finish, error, azure_functions, asyncFinish

      before(() => {
        return agent.load(moduleName)
      })

      after(() => {
        return agent.close({ ritmReset: false })
      })

      beforeEach(() => {
        start = sinon.stub()
        finish = sinon.stub() /// ***
        error = sinon.stub()
        asyncFinish = sinon.stub()

        azureFunctionsChannel.subscribe({
          start,
          end: finish,
          asyncEnd: asyncFinish,
          error
        })

        azure_functions = require(moduleName)
      })

      afterEach(() => {
        azureFunctionsChannel.unsubscribe({
          start,
          end: finish,
          asyncEnd: asyncFinish,
          error
        })
      })

    it('should instrument service methods with a callback', (done) => {
        agent.use(traces => {
            const span = sort(traces[0])[0]
            console.log("span: ", span);
        }).then(done, done)
      })
    })
  })
})
