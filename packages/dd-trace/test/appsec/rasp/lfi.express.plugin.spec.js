'use strict'

const Axios = require('axios')
const os = require('os')
const fs = require('fs')
const agent = require('../../plugins/agent')
const appsec = require('../../../src/appsec')
const Config = require('../../../src/config')
const path = require('path')
const { assert } = require('chai')
const { checkRaspExecutedAndNotThreat, checkRaspExecutedAndHasThreat } = require('./utils')

describe('RASP - lfi', () => {
  let axios

  async function testBlockingRequest (url = '/?file=/test.file', config = undefined, ruleEvalCount = 1) {
    try {
      await axios.get(url, config)
    } catch (e) {
      if (!e.response) {
        throw e
      }

      assert.strictEqual(e.response.status, 418) // a teapot

      return checkRaspExecutedAndHasThreat(agent, 'rasp-lfi-rule-id-1', ruleEvalCount)
    }

    assert.fail('Request should be blocked')
  }

  withVersions('express', 'express', expressVersion => {
    let app, server

    before(() => {
      return agent.load(['http', 'express'], { client: false })
    })

    before((done) => {
      const express = require(`../../../../../versions/express@${expressVersion}`).get()
      const expressApp = express()

      expressApp.get('/', (req, res) => {
        app(req, res)
      })

      appsec.enable(new Config({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'resources', 'lfi_rasp_rules.json'),
          rasp: { enabled: true }
        }
      }))

      server = expressApp.listen(0, () => {
        const port = server.address().port
        axios = Axios.create({
          baseURL: `http://localhost:${port}`
        })
        done()
      })
    })

    after(() => {
      appsec.disable()
      server.close()
      return agent.close({ ritmReset: false })
    })

    describe('lfi', () => {
      function getApp (fn, args, options) {
        return async (req, res) => {
          try {
            const result = await fn(args)
            options.onfinish?.(result)
          } catch (e) {
            if (e.message === 'DatadogRaspAbortError') {
              res.writeHead(418)
            }
          }
          res.end('end')
        }
      }

      function getAppSync (fn, args, options) {
        return (req, res) => {
          try {
            const result = fn(args)
            options.onfinish?.(result)
          } catch (e) {
            if (e.message === 'DatadogRaspAbortError') {
              res.writeHead(418)
            }
          }
          res.end('end')
        }
      }

      function runFsMethodTest (description, options, fn, ...args) {
        const { vulnerableIndex = 0, ruleEvalCount } = options

        describe(description, () => {
          const getAppFn = options.getAppFn ?? getApp

          it('should block param from the request', () => {
            app = getAppFn(fn, args, options)

            const file = args[vulnerableIndex]
            return testBlockingRequest(`/?file=${file}`, undefined, ruleEvalCount)
              .then(span => {
                assert(span.meta['_dd.appsec.json'].includes(file))
              })
          })

          it('should not block if param not found in the request', async () => {
            app = getAppFn(fn, args, options)

            await axios.get('/?file=/test.file')

            return checkRaspExecutedAndNotThreat(agent, false)
          })
        })
      }

      function runFsMethodTestThreeWay (methodName, options = {}, ...args) {
        let desc = `test ${methodName} ${options.desc ?? ''}`
        const { vulnerableIndex = 0 } = options
        if (vulnerableIndex !== 0) {
          desc += ` with vulnerable index ${vulnerableIndex}`
        }
        describe(desc, () => {
          runFsMethodTest(`test fs.${methodName}Sync method`, { ...options, getAppFn: getAppSync }, (args) => {
            return require('fs')[`${methodName}Sync`](...args)
          }, ...args)

          runFsMethodTest(`test fs.${methodName} method`, options, (args) => {
            return new Promise((resolve, reject) => {
              require('fs')[methodName](...args, (err, res) => {
                if (err) reject(err)
                else resolve(res)
              })
            })
          }, ...args)

          runFsMethodTest(`test fs.promises.${methodName} method`, options, async (args) => {
            return require('fs').promises[methodName](...args)
          }, ...args)
        })
      }

      function unlink (...args) {
        args.forEach(arg => {
          try {
            fs.unlinkSync(arg)
          } catch (e) {

          }
        })
      }

      describe('test access', () => {
        runFsMethodTestThreeWay('access', undefined, __filename)
        runFsMethodTestThreeWay('access', { desc: 'Buffer' }, Buffer.from(__filename))

        // not supported by waf yet
        // runFsMethodTestThreeWay('access', { desc: 'URL' }, new URL(`file://${__filename}`))
      })

      describe('test appendFile', () => {
        const filename = path.join(os.tmpdir(), 'test-appendfile')

        beforeEach(() => {
          fs.writeFileSync(filename, '')
        })

        afterEach(() => {
          fs.unlinkSync(filename)
        })

        runFsMethodTestThreeWay('appendFile', undefined, filename, 'test-content')
      })

      describe('test chmod', () => {
        const filename = path.join(os.tmpdir(), 'test-chmod')

        beforeEach(() => {
          fs.writeFileSync(filename, '')
        })

        afterEach(() => {
          fs.unlinkSync(filename)
        })
        runFsMethodTestThreeWay('chmod', undefined, filename, '666')
      })

      describe('test copyFile', () => {
        const src = path.join(os.tmpdir(), 'test-copyFile-src')
        const dest = path.join(os.tmpdir(), 'test-copyFile-dst')

        beforeEach(() => {
          fs.writeFileSync(src, '')
        })

        afterEach(() => unlink(src, dest))

        runFsMethodTestThreeWay('copyFile', { vulnerableIndex: 0, ruleEvalCount: 2 }, src, dest)
        runFsMethodTestThreeWay('copyFile', { vulnerableIndex: 1, ruleEvalCount: 2 }, src, dest)
      })

      describe('test link', () => {
        const src = path.join(os.tmpdir(), 'test-link-src')
        const dest = path.join(os.tmpdir(), 'test-link-dst')

        beforeEach(() => {
          fs.writeFileSync(src, '')
        })

        afterEach(() => unlink(src, dest))

        runFsMethodTestThreeWay('copyFile', { vulnerableIndex: 0, ruleEvalCount: 2 }, src, dest)
        runFsMethodTestThreeWay('copyFile', { vulnerableIndex: 1, ruleEvalCount: 2 }, src, dest)
      })

      describe('test lstat', () => {
        runFsMethodTestThreeWay('lstat', undefined, __filename)
      })

      describe('test mkdir', () => {
        const dirname = path.join(os.tmpdir(), 'test-mkdir')

        afterEach(() => {
          try {
            fs.rmdirSync(dirname)
          } catch (e) {
            // some ops are blocked
          }
        })
        runFsMethodTestThreeWay('mkdir', undefined, dirname)
      })

      describe('test mkdtemp', () => {
        const dirname = path.join(os.tmpdir(), 'test-mkdtemp')

        runFsMethodTestThreeWay('mkdtemp', {
          onfinish: (todelete) => {
            try {
              fs.rmdirSync(todelete)
            } catch (e) {
              // some ops are blocked
            }
          }
        }, dirname)
      })

      describe('test open', () => {
        runFsMethodTestThreeWay('open', {
          onfinish: (fd) => {
            if (fd && fd.close) {
              fd.close()
            } else {
              fs.close(fd, () => {})
            }
          }
        }, __filename, 'r')
      })

      describe('test opendir', () => {
        const dirname = path.join(os.tmpdir(), 'test-opendir')

        beforeEach(() => {
          fs.mkdirSync(dirname)
        })

        afterEach(() => {
          fs.rmdirSync(dirname)
        })
        runFsMethodTestThreeWay('opendir', {
          onfinish: (dir) => {
            dir.close()
          }
        }, dirname)
      })

      describe('test readdir', () => {
        const dirname = path.join(os.tmpdir(), 'test-opendir')

        beforeEach(() => {
          fs.mkdirSync(dirname)
        })

        afterEach(() => {
          fs.rmdirSync(dirname)
        })
        runFsMethodTestThreeWay('readdir', undefined, dirname)
      })

      describe('test readFile', () => {
        runFsMethodTestThreeWay('readFile', undefined, __filename)

        runFsMethodTest('an async operation without callback is executed before',
          { getAppFn: getAppSync, ruleEvalCount: 2 }, (args) => {
            const fs = require('fs')
            fs.readFile(path.join(__dirname, 'utils.js'), () => {}) // safe and ignored operation
            return fs.readFileSync(...args)
          }, __filename)
      })

      describe('test readlink', () => {
        const src = path.join(os.tmpdir(), 'test-readlink-src')
        const dest = path.join(os.tmpdir(), 'test-readlink-dst')

        beforeEach(() => {
          fs.writeFileSync(src, '')
          fs.linkSync(src, dest)
        })

        afterEach(() => unlink(src, dest))

        runFsMethodTestThreeWay('readlink', undefined, dest)
      })

      describe('test realpath', () => {
        runFsMethodTestThreeWay('realpath', undefined, __filename)

        runFsMethodTest('test fs.realpath.native method', {}, (args) => {
          return new Promise((resolve, reject) => {
            require('fs').realpath.native(...args, (err, result) => {
              if (err) reject(err)
              else resolve(result)
            })
          })
        }, __filename)
      })

      describe('test rename', () => {
        const src = path.join(os.tmpdir(), 'test-rename-src')
        const dest = path.join(os.tmpdir(), 'test-rename-dst')

        beforeEach(() => {
          fs.writeFileSync(src, '')
        })

        afterEach(() => unlink(dest))

        runFsMethodTestThreeWay('rename', { vulnerableIndex: 0, ruleEvalCount: 2 }, src, dest)
        runFsMethodTestThreeWay('rename', { vulnerableIndex: 1, ruleEvalCount: 2 }, src, dest)
      })

      describe('test rmdir', () => {
        const dirname = path.join(os.tmpdir(), 'test-rmdir')

        beforeEach(() => {
          fs.mkdirSync(dirname)
        })

        afterEach(() => {
          try { fs.rmdirSync(dirname) } catch (e) {}
        })

        runFsMethodTestThreeWay('rmdir', undefined, dirname)
      })

      describe('test stat', () => {
        runFsMethodTestThreeWay('stat', undefined, __filename)
      })

      describe('test symlink', () => {
        const src = path.join(os.tmpdir(), 'test-symlink-src')
        const dest = path.join(os.tmpdir(), 'test-symlink-dst')

        beforeEach(() => {
          fs.writeFileSync(src, '')
        })

        afterEach(() => {
          unlink(src, dest)
        })

        runFsMethodTestThreeWay('symlink', { vulnerableIndex: 0, ruleEvalCount: 2 }, src, dest)
        runFsMethodTestThreeWay('symlink', { vulnerableIndex: 1, ruleEvalCount: 2 }, src, dest)
      })

      describe('test truncate', () => {
        const src = path.join(os.tmpdir(), 'test-truncate-src')

        beforeEach(() => {
          fs.writeFileSync(src, 'aaaaaa')
        })

        afterEach(() => unlink(src))

        runFsMethodTestThreeWay('truncate', undefined, src)
      })

      describe('test unlink', () => {
        const src = path.join(os.tmpdir(), 'test-unlink-src')

        beforeEach(() => {
          fs.writeFileSync(src, '')
        })
        runFsMethodTestThreeWay('unlink', undefined, src)
      })

      describe('test writeFile', () => {
        const src = path.join(os.tmpdir(), 'test-writeFile-src')

        afterEach(() => unlink(src))

        runFsMethodTestThreeWay('writeFile', undefined, src, 'content')
      })
    })
  })

  describe('without express', () => {
    let app, server

    before(() => {
      return agent.load(['http'], { client: false })
    })

    before((done) => {
      const http = require('http')
      server = http.createServer((req, res) => {
        if (app) {
          app(req, res)
        } else {
          res.end('end')
        }
      })

      appsec.enable(new Config({
        appsec: {
          enabled: true,
          rules: path.join(__dirname, 'resources', 'lfi_rasp_rules.json'),
          rasp: { enabled: true }
        }
      }))

      server.listen(0, () => {
        const port = server.address().port
        axios = Axios.create({
          baseURL: `http://localhost:${port}`
        })

        done()
      })
    })

    after(() => {
      appsec.disable()
      server.close()
      return agent.close({ ritmReset: false })
    })

    it('Should detect threat but not block', async () => {
      app = (req, res) => {
        try {
          require('fs').statSync(req.headers.file)
        } catch (e) {
          if (e.message === 'DatadogRaspAbortError') {
            res.writeHead(500)
          } else {
            res.writeHead(418)
          }
        }
        res.end('end')
      }

      return testBlockingRequest('/', {
        headers: {
          file: '/test.file'
        }
      })
    })
  })
})
