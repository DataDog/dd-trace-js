'use strict'

const { prepareTestServerForIastInExpress } = require('../utils')
const axios = require('axios')
const path = require('path')
const os = require('os')
const fs = require('fs')
const { clearCache } = require('../../../../src/appsec/iast/vulnerability-reporter')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')
const { SQL_ROW_VALUE } = require('../../../../src/appsec/iast/taint-tracking/source-types')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')

describe('Code injection vulnerability', () => {
  withVersions('express', 'express', '>4.18.0', version => {
    let i = 0
    let evalFunctionsPath

    beforeEach(() => {
      evalFunctionsPath = path.join(os.tmpdir(), `eval-methods-${i++}.js`)
      fs.copyFileSync(
        path.join(__dirname, 'resources', 'eval-methods.js'),
        evalFunctionsPath
      )
    })

    afterEach(() => {
      fs.unlinkSync(evalFunctionsPath)
      clearCache()
    })

    prepareTestServerForIastInExpress('in express', version,
      (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
        testThatRequestHasVulnerability({
          fn: (req, res) => {
            res.send(require(evalFunctionsPath).runEval(req.query.script, 'test-result'))
          },
          vulnerability: 'CODE_INJECTION',
          makeRequest: (done, config) => {
            axios.get(`http://localhost:${config.port}/?script=1%2B2`)
              .then(res => {
                expect(res.data).to.equal('test-result')
              })
              .catch(done)
          }
        })

        testThatRequestHasVulnerability({
          fn: (req, res) => {
            const source = '1 + 2'
            const store = storage.getStore()
            const iastContext = iastContextFunctions.getIastContext(store)
            const str = newTaintedString(iastContext, source, 'param', SQL_ROW_VALUE)

            res.send(require(evalFunctionsPath).runEval(str, 'test-result'))
          },
          vulnerability: 'CODE_INJECTION',
          testDescription: 'Should detect CODE_INJECTION vulnerability with DB source'
        })

        testThatRequestHasNoVulnerability({
          fn: (req, res) => {
            res.send('' + require(evalFunctionsPath).runFakeEval(req.query.script))
          },
          vulnerability: 'CODE_INJECTION',
          makeRequest: (done, config) => {
            axios.get(`http://localhost:${config.port}/?script=1%2B2`).catch(done)
          }
        })

        testThatRequestHasNoVulnerability((req, res) => {
          res.send('' + require(evalFunctionsPath).runEval('1 + 2'))
        }, 'CODE_INJECTION')
      })
  })
})
