'use strict'

const os = require('os')
const path = require('path')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const expect = require('chai').expect
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const pathTraversalAnalyzer = require('../../../../src/appsec/iast/analyzers/path-traversal-analyzer')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')

const { prepareTestServerForIast } = require('../utils')
const fs = require('fs')

const iastContext = {
  rootSpan: {
    context () {
      return {
        toSpanId () {
          return '123'
        }
      }
    }
  }
}

const TaintTrackingMock = {
  isTainted: sinon.stub()
}

const getIastContext = sinon.stub()
const hasQuota = sinon.stub()
const addVulnerability = sinon.stub()

const ProxyAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/vulnerability-analyzer', {
  '../iast-context': { getIastContext },
  '../overhead-controller': { hasQuota },
  '../vulnerability-reporter': { addVulnerability }
})

const InjectionAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/injection-analyzer', {
  './vulnerability-analyzer': ProxyAnalyzer,
  '../taint-tracking/operations': TaintTrackingMock
})

describe('path-traversal-analyzer', () => {
  it('Analyzer should be subscribed to proper channel', () => {
    expect(pathTraversalAnalyzer._subscriptions).to.have.lengthOf(1)
    expect(pathTraversalAnalyzer._subscriptions[0]._channel.name).to.equals('apm:fs:operation:start')
  })

  it('If no context it should not report vulnerability', () => {
    const iastContext = null
    const isVulnerable = pathTraversalAnalyzer._isVulnerable('test', iastContext)
    expect(isVulnerable).to.be.false
  })

  it('If no context it should return evidence with an undefined ranges array', () => {
    const evidence = pathTraversalAnalyzer._getEvidence('', null)
    expect(evidence.value).to.be.equal('')
    expect(evidence.ranges).to.be.instanceof(Array)
    expect(evidence.ranges).to.have.length(0)
  })

  it('if context exists but value is not a string it should not call isTainted', () => {
    const isTainted = sinon.stub()
    const iastContext = {}
    const proxyPathAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/path-traversal-analyzer', {
      '../taint-tracking': { isTainted }
    })

    proxyPathAnalyzer._isVulnerable(undefined, iastContext)
    expect(isTainted).not.to.have.been.called
  })

  it('if context and value are valid it should call isTainted', () => {
    // const isTainted = sinon.stub()
    const iastContext = {}
    const proxyPathAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/path-traversal-analyzer', {
      './injection-analyzer': InjectionAnalyzer
    })
    TaintTrackingMock.isTainted.returns(false)
    const result = proxyPathAnalyzer._isVulnerable('test', iastContext)
    expect(result).to.be.false
    expect(TaintTrackingMock.isTainted).to.have.been.calledOnce
  })

  it('Should report proper vulnerability type', () => {
    const proxyPathAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/path-traversal-analyzer', {
      './injection-analyzer': InjectionAnalyzer,
      '../iast-context': { getIastContext: () => iastContext }
    })

    getIastContext.returns(iastContext)
    hasQuota.returns(true)
    TaintTrackingMock.isTainted.returns(true)

    proxyPathAnalyzer.analyze(['test'])
    expect(addVulnerability).to.have.been.calledOnce
    expect(addVulnerability).to.have.been.calledWithMatch(iastContext, { type: 'PATH_TRAVERSAL' })
  })

  it('Should report 1st argument', () => {
    const proxyPathAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/path-traversal-analyzer',
      { './injection-analyzer': InjectionAnalyzer,
        '../iast-context': { getIastContext: () => iastContext }
      })

    addVulnerability.reset()
    getIastContext.returns(iastContext)
    TaintTrackingMock.isTainted.returns(true)
    hasQuota.returns(true)

    proxyPathAnalyzer.analyze(['taintedArg1', 'taintedArg2'])
    expect(addVulnerability).to.have.been.calledOnce
    expect(addVulnerability).to.have.been.calledWithMatch(iastContext, { evidence: { value: 'taintedArg1' } })
  })

  it('Should report 2nd argument', () => {
    const proxyPathAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/path-traversal-analyzer', {
      './injection-analyzer': InjectionAnalyzer,
      '../iast-context': { getIastContext: () => iastContext }
    })

    addVulnerability.reset()
    TaintTrackingMock.isTainted.reset()
    getIastContext.returns(iastContext)
    TaintTrackingMock.isTainted.onFirstCall().returns(false)
    TaintTrackingMock.isTainted.onSecondCall().returns(true)
    hasQuota.returns(true)

    proxyPathAnalyzer.analyze(['arg1', 'taintedArg2'])
    expect(addVulnerability).to.have.been.calledOnce
    expect(addVulnerability).to.have.been.calledWithMatch(iastContext, { evidence: { value: 'taintedArg2' } })
  })

  it('Should not report the vulnerability if it comes from send module', () => {
    const mockPath = path.join('node_modules', 'send', 'send.js')
    const proxyPathAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/path-traversal-analyzer', {
      './injection-analyzer': InjectionAnalyzer,
      '../iast-context': { getIastContext: () => iastContext }
    })

    proxyPathAnalyzer._getLocation = function () {
      return { path: mockPath, line: 3 }
    }

    addVulnerability.reset()
    TaintTrackingMock.isTainted.reset()
    getIastContext.returns(iastContext)
    TaintTrackingMock.isTainted.returns(true)
    hasQuota.returns(true)

    proxyPathAnalyzer.analyze(['arg1'])
    expect(addVulnerability).not.have.been.called
  })
})

prepareTestServerForIast('integration test', (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
  function runFsMethodTest (description, vulnerableIndex, fn, ...args) {
    describe(description, () => {
      describe('vulnerable', () => {
        testThatRequestHasVulnerability(function () {
          const store = storage.getStore()
          const iastCtx = iastContextFunctions.getIastContext(store)
          const callArgs = [...args]
          if (vulnerableIndex > -1) {
            callArgs[vulnerableIndex] = newTaintedString(iastCtx, callArgs[vulnerableIndex], 'param', 'Request')
          }
          return fn(callArgs)
        }, 'PATH_TRAVERSAL')
      })
      describe('no vulnerable', () => {
        testThatRequestHasNoVulnerability(function () {
          return fn(args)
        }, 'PATH_TRAVERSAL')
      })
    })
  }
  function noop () {}
  function runFsMethodTestThreeWay (methodName, vulnerableIndex, cb, ...args) {
    cb = cb || noop
    let desc = `test ${methodName}`
    if (vulnerableIndex !== 0) {
      desc += `with vulnerabile index ${vulnerableIndex}`
    }
    describe(desc, () => {
      runFsMethodTest(`test fs.${methodName}Sync method`, vulnerableIndex, (args) => {
        const method = `${methodName}Sync`
        try {
          const res = fs[method](...args)
          cb(res)
        } catch (e) {
          cb(null)
        }
      }, ...args)
      runFsMethodTest(`test fs.${methodName} method`, vulnerableIndex, (args) => {
        return new Promise((resolve, reject) => {
          fs[methodName](...args, (err, res) => {
            resolve(cb(res))
          })
        })
      }, ...args)
      runFsMethodTest(`test fs.promises.${methodName} method`, vulnerableIndex, (args) => {
        return fs.promises[methodName](...args).then(cb).catch(cb)
      }, ...args)
    })
  }

  describe('test access', () => {
    runFsMethodTestThreeWay('access', 0, null, __filename)
  })

  describe('test appendFile', () => {
    const filename = path.join(os.tmpdir(), 'test-appendfile')
    beforeEach(() => {
      fs.writeFileSync(filename, '')
    })
    afterEach(() => {
      fs.unlinkSync(filename)
    })

    runFsMethodTestThreeWay('appendFile', 0, null, filename, 'test-content')
  })

  describe('test chmod', () => {
    const filename = path.join(os.tmpdir(), 'test-chmod')
    beforeEach(() => {
      fs.writeFileSync(filename, '')
    })
    afterEach(() => {
      fs.unlinkSync(filename)
    })
    runFsMethodTestThreeWay('chmod', 0, null, filename, '666')
  })

  describe('test copyFile', () => {
    const src = path.join(os.tmpdir(), 'test-copyFile-src')
    const dest = path.join(os.tmpdir(), 'test-copyFile-dst')
    beforeEach(() => {
      fs.writeFileSync(src, '')
    })
    afterEach(() => {
      fs.unlinkSync(src)
      fs.unlinkSync(dest)
    })
    runFsMethodTestThreeWay('copyFile', 0, null, src, dest)
    runFsMethodTestThreeWay('copyFile', 1, null, src, dest)
  })

  if (fs.cp) {
    describe('test cp', () => {
      const src = path.join(os.tmpdir(), 'test-cp-src')
      const dest = path.join(os.tmpdir(), 'test-cp-dst')
      beforeEach(() => {
        fs.writeFileSync(src, '')
      })
      afterEach(() => {
        fs.unlinkSync(src)
        fs.unlinkSync(dest)
      })
      runFsMethodTestThreeWay('cp', 0, null, src, dest)
      runFsMethodTestThreeWay('cp', 1, null, src, dest)
    })
  }

  describe('test createReadStream', () => {
    runFsMethodTest(`test fs.createReadStream method`, 0, (args) => {
      const rs = fs.createReadStream(...args)
      rs.close()
    }, __filename)
  })

  describe('test createWriteStream', () => {
    const filepath = path.join(os.tmpdir(), 'test-createWriteStream')
    beforeEach(() => {
      fs.writeFileSync(filepath, '')
    })
    afterEach(() => {
      fs.unlinkSync(filepath)
    })

    runFsMethodTest(`test fs.createWriteStream method`, 0, (args) => {
      const rs = fs.createWriteStream(...args)
      return new Promise((resolve, reject) => {
        rs.close((err) => {
          if (err) {
            reject(err)
            return
          }
          resolve()
        })
      })
    }, filepath)
  })

  describe('test link', () => {
    const src = path.join(os.tmpdir(), 'test-link-src')
    const dest = path.join(os.tmpdir(), 'test-link-dst')
    beforeEach(() => {
      fs.writeFileSync(src, '')
    })
    afterEach(() => {
      fs.unlinkSync(src)
      fs.unlinkSync(dest)
    })
    runFsMethodTestThreeWay('link', 0, null, src, dest)
  })

  describe('test lstat', () => {
    runFsMethodTestThreeWay('lstat', 0, null, __filename)
  })

  describe('test mkdir', () => {
    const dirname = path.join(os.tmpdir(), 'test-mkdir')

    afterEach(() => {
      fs.rmdirSync(dirname)
    })
    runFsMethodTestThreeWay('mkdir', 0, null, dirname)
  })

  describe('test mkdtemp', () => {
    const dirname = path.join(os.tmpdir(), 'test-mkdtemp')

    runFsMethodTestThreeWay('mkdtemp', 0, (todelete) => {
      fs.rmdirSync(todelete)
    }, dirname)
  })

  describe('test open', () => {
    runFsMethodTestThreeWay('open', 0, (fd) => {
      if (fd && fd.close) {
        fd.close()
      } else {
        fs.close(fd, () => {})
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
    runFsMethodTestThreeWay('opendir', 0, (dir) => {
      dir.close()
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
    runFsMethodTestThreeWay('readdir', 0, null, dirname)
  })

  describe('test readFile', () => {
    runFsMethodTestThreeWay('readFile', 0, null, __filename)
  })

  describe('test readlink', () => {
    const src = path.join(os.tmpdir(), 'test-readlink-src')
    const dest = path.join(os.tmpdir(), 'test-readlink-dst')

    beforeEach(() => {
      fs.writeFileSync(src, '')
      fs.linkSync(src, dest)
    })
    afterEach(() => {
      fs.unlinkSync(src)
      fs.unlinkSync(dest)
    })

    runFsMethodTestThreeWay('readlink', 0, null, dest)
  })

  describe('test realpath', () => {
    runFsMethodTestThreeWay('realpath', 0, null, __filename)

    runFsMethodTest(`test fs.realpath.native method`, 0, (args) => {
      fs.realpath.native(...args, () => {})
    }, __filename)
  })

  describe('test rename', () => {
    const src = path.join(os.tmpdir(), 'test-rename-src')
    const dest = path.join(os.tmpdir(), 'test-rename-dst')
    beforeEach(() => {
      fs.writeFileSync(src, '')
    })
    afterEach(() => {
      fs.unlinkSync(dest)
    })
    runFsMethodTestThreeWay('rename', 0, null, src, dest)
    runFsMethodTestThreeWay('rename', 1, null, src, dest)
  })

  describe('test rmdir', () => {
    const dirname = path.join(os.tmpdir(), 'test-rmdir')
    beforeEach(() => {
      fs.mkdirSync(dirname)
    })

    runFsMethodTestThreeWay('rmdir', 0, null, dirname)
  })
  if (fs.rm) {
    describe('test rm', () => {
      const filename = path.join(os.tmpdir(), 'test-rmdir')
      beforeEach(() => {
        fs.writeFileSync(filename, '')
      })

      runFsMethodTestThreeWay('rm', 0, null, filename)
    })
  }

  describe('test stat', () => {
    runFsMethodTestThreeWay('stat', 0, null, __filename)
  })

  describe('test symlink', () => {
    const src = path.join(os.tmpdir(), 'test-symlink-src')
    const dest = path.join(os.tmpdir(), 'test-symlink-dst')
    beforeEach(() => {
      fs.writeFileSync(src, '')
    })
    afterEach(() => {
      fs.unlinkSync(src)
      fs.unlinkSync(dest)
    })
    runFsMethodTestThreeWay('symlink', 0, null, src, dest)
    runFsMethodTestThreeWay('symlink', 1, null, src, dest)
  })

  describe('test truncate', () => {
    const src = path.join(os.tmpdir(), 'test-truncate-src')
    beforeEach(() => {
      fs.writeFileSync(src, 'aaaaaa')
    })
    afterEach(() => {
      fs.unlinkSync(src)
    })
    runFsMethodTestThreeWay('truncate', 0, null, src)
  })

  describe('test unlink', () => {
    const src = path.join(os.tmpdir(), 'test-unlink-src')
    beforeEach(() => {
      fs.writeFileSync(src, '')
    })
    runFsMethodTestThreeWay('unlink', 0, null, src)
  })

  describe('test unwatchFile', () => {
    const listener = () => {}
    beforeEach(() => {
      fs.watchFile(__filename, listener)
    })
    runFsMethodTest(`test fs.watchFile method`, 0, (args) => {
      fs.unwatchFile(...args)
    }, __filename, listener)
  })

  describe('test writeFile', () => {
    const src = path.join(os.tmpdir(), 'test-writeFile-src')
    afterEach(() => {
      fs.unlinkSync(src)
    })
    runFsMethodTestThreeWay('writeFile', 0, null, src, 'content')
  })

  describe('test watch', () => {
    runFsMethodTest(`test fs.watch method`, 0, (args) => {
      const watcher = fs.watch(...args, () => {})
      watcher.close()
    }, __filename)
  })

  describe('test watchFile', () => {
    const listener = () => {}
    afterEach(() => {
      fs.unwatchFile(__filename, listener)
    })
    runFsMethodTest(`test fs.watchFile method`, 0, (args) => {
      fs.watchFile(...args, listener)
    }, __filename)
  })
})
