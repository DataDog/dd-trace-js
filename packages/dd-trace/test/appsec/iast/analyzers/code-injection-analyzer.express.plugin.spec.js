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
const { withVersions } = require('../../../setup/mocha')

describe('Code injection vulnerability', () => {
  withVersions('express', 'express', version => {
    describe('Eval', () => {
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
              const store = storage('legacy').getStore()
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

    describe('Node:vm', () => {
      let context, vm

      beforeEach(() => {
        vm = require('vm')
        context = {}
        vm.createContext(context)
      })

      afterEach(() => {
        vm = null
        context = null
      })

      prepareTestServerForIastInExpress('runInContext in express', version,
        (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          testThatRequestHasVulnerability({
            fn: (req, res) => {
              const result = vm.runInContext(req.query.script, context)

              res.send(`${result}`)
            },
            vulnerability: 'CODE_INJECTION',
            makeRequest: (done, config) => {
              axios.get(`http://localhost:${config.port}/?script=1%2B2`)
                .then(res => {
                  expect(res.data).to.equal(3)
                })
                .catch(done)
            }
          })

          testThatRequestHasVulnerability({
            fn: (req, res) => {
              const source = '1 + 2'
              const store = storage('legacy').getStore()
              const iastContext = iastContextFunctions.getIastContext(store)
              const str = newTaintedString(iastContext, source, 'param', SQL_ROW_VALUE)

              const result = vm.runInContext(str, context)
              res.send(`${result}`)
            },
            vulnerability: 'CODE_INJECTION',
            testDescription: 'Should detect CODE_INJECTION vulnerability with DB source'
          })

          testThatRequestHasNoVulnerability((req, res) => {
            const result = vm.runInContext('1 + 2', context)

            res.send(`${result}`)
          }, 'CODE_INJECTION')
        })

      prepareTestServerForIastInExpress('runInNewContext in express', version,
        (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          testThatRequestHasVulnerability({
            fn: (req, res) => {
              const result = vm.runInNewContext(req.query.script)

              res.send(`${result}`)
            },
            vulnerability: 'CODE_INJECTION',
            makeRequest: (done, config) => {
              axios.get(`http://localhost:${config.port}/?script=1%2B2`)
                .then(res => {
                  expect(res.data).to.equal(3)
                })
                .catch(done)
            }
          })

          testThatRequestHasVulnerability({
            fn: (req, res) => {
              const source = '1 + 2'
              const store = storage('legacy').getStore()
              const iastContext = iastContextFunctions.getIastContext(store)
              const str = newTaintedString(iastContext, source, 'param', SQL_ROW_VALUE)

              const result = vm.runInNewContext(str)
              res.send(`${result}`)
            },
            vulnerability: 'CODE_INJECTION',
            testDescription: 'Should detect CODE_INJECTION vulnerability with DB source'
          })

          testThatRequestHasNoVulnerability((req, res) => {
            const result = vm.runInNewContext('1 + 2')

            res.send(`${result}`)
          }, 'CODE_INJECTION')
        })

      prepareTestServerForIastInExpress('runInThisContext in express', version,
        (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          testThatRequestHasVulnerability({
            fn: (req, res) => {
              const result = vm.runInThisContext(req.query.script)

              res.send(`${result}`)
            },
            vulnerability: 'CODE_INJECTION',
            makeRequest: (done, config) => {
              axios.get(`http://localhost:${config.port}/?script=1%2B2`)
                .then(res => {
                  expect(res.data).to.equal(3)
                })
                .catch(done)
            }
          })

          testThatRequestHasVulnerability({
            fn: (req, res) => {
              const source = '1 + 2'
              const store = storage('legacy').getStore()
              const iastContext = iastContextFunctions.getIastContext(store)
              const str = newTaintedString(iastContext, source, 'param', SQL_ROW_VALUE)

              const result = vm.runInThisContext(str)
              res.send(`${result}`)
            },
            vulnerability: 'CODE_INJECTION',
            testDescription: 'Should detect CODE_INJECTION vulnerability with DB source'
          })

          testThatRequestHasNoVulnerability((req, res) => {
            const result = vm.runInThisContext('1 + 2')

            res.send(`${result}`)
          }, 'CODE_INJECTION')
        })

      prepareTestServerForIastInExpress('compileFunction in express', version,
        (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          testThatRequestHasVulnerability({
            fn: (req, res) => {
              const fn = vm.compileFunction(req.query.script)
              const result = fn()

              res.send(`${result}`)
            },
            vulnerability: 'CODE_INJECTION',
            makeRequest: (done, config) => {
              axios.get(`http://localhost:${config.port}/?script=return%201%2B2`)
                .then(res => {
                  expect(res.data).to.equal(3)
                })
                .catch(done)
            }
          })

          testThatRequestHasVulnerability({
            fn: (req, res) => {
              const source = '1 + 2'
              const store = storage('legacy').getStore()
              const iastContext = iastContextFunctions.getIastContext(store)
              const str = newTaintedString(iastContext, source, 'param', SQL_ROW_VALUE)

              const result = vm.runInThisContext(str)
              res.send(`${result}`)
            },
            vulnerability: 'CODE_INJECTION',
            testDescription: 'Should detect CODE_INJECTION vulnerability with DB source'
          })

          testThatRequestHasNoVulnerability((req, res) => {
            const result = vm.runInThisContext('1 + 2')

            res.send(`${result}`)
          }, 'CODE_INJECTION')
        })

      describe('Script class', () => {
        prepareTestServerForIastInExpress('runInContext in express', version,
          (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
            testThatRequestHasVulnerability({
              fn: (req, res) => {
                const script = new vm.Script(req.query.script)
                const result = script.runInContext(context)

                res.send(`${result}`)
              },
              vulnerability: 'CODE_INJECTION',
              makeRequest: (done, config) => {
                axios.get(`http://localhost:${config.port}/?script=1%2B2`)
                  .then(res => {
                    expect(res.data).to.equal(3)
                  })
                  .catch(done)
              }
            })

            testThatRequestHasVulnerability({
              fn: (req, res) => {
                const source = '1 + 2'
                const store = storage('legacy').getStore()
                const iastContext = iastContextFunctions.getIastContext(store)
                const str = newTaintedString(iastContext, source, 'param', SQL_ROW_VALUE)

                const script = new vm.Script(str)
                const result = script.runInContext(context)
                res.send(`${result}`)
              },
              vulnerability: 'CODE_INJECTION',
              testDescription: 'Should detect CODE_INJECTION vulnerability with DB source'
            })

            testThatRequestHasNoVulnerability((req, res) => {
              const script = new vm.Script('1 + 2')
              const result = script.runInContext(context)

              res.send(`${result}`)
            }, 'CODE_INJECTION')
          })

        prepareTestServerForIastInExpress('runInNewContext in express', version,
          (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
            testThatRequestHasVulnerability({
              fn: (req, res) => {
                const script = new vm.Script(req.query.script)
                const result = script.runInNewContext()

                res.send(`${result}`)
              },
              vulnerability: 'CODE_INJECTION',
              makeRequest: (done, config) => {
                axios.get(`http://localhost:${config.port}/?script=1%2B2`)
                  .then(res => {
                    expect(res.data).to.equal(3)
                  })
                  .catch(done)
              }
            })

            testThatRequestHasVulnerability({
              fn: (req, res) => {
                const source = '1 + 2'
                const store = storage('legacy').getStore()
                const iastContext = iastContextFunctions.getIastContext(store)
                const str = newTaintedString(iastContext, source, 'param', SQL_ROW_VALUE)

                const script = new vm.Script(str)
                const result = script.runInNewContext()
                res.send(`${result}`)
              },
              vulnerability: 'CODE_INJECTION',
              testDescription: 'Should detect CODE_INJECTION vulnerability with DB source'
            })

            testThatRequestHasNoVulnerability((req, res) => {
              const script = new vm.Script('1 + 2')
              const result = script.runInNewContext()

              res.send(`${result}`)
            }, 'CODE_INJECTION')
          })

        prepareTestServerForIastInExpress('runInThisContext in express', version,
          (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
            testThatRequestHasVulnerability({
              fn: (req, res) => {
                const script = new vm.Script(req.query.script)
                const result = script.runInThisContext()

                res.send(`${result}`)
              },
              vulnerability: 'CODE_INJECTION',
              makeRequest: (done, config) => {
                axios.get(`http://localhost:${config.port}/?script=1%2B2`)
                  .then(res => {
                    expect(res.data).to.equal(3)
                  })
                  .catch(done)
              }
            })

            testThatRequestHasVulnerability({
              fn: (req, res) => {
                const source = '1 + 2'
                const store = storage('legacy').getStore()
                const iastContext = iastContextFunctions.getIastContext(store)
                const str = newTaintedString(iastContext, source, 'param', SQL_ROW_VALUE)

                const script = new vm.Script(str)
                const result = script.runInThisContext()
                res.send(`${result}`)
              },
              vulnerability: 'CODE_INJECTION',
              testDescription: 'Should detect CODE_INJECTION vulnerability with DB source'
            })

            testThatRequestHasNoVulnerability((req, res) => {
              const script = new vm.Script('1 + 2')
              const result = script.runInThisContext()

              res.send(`${result}`)
            }, 'CODE_INJECTION')
          })
      })
    })
  })
})
