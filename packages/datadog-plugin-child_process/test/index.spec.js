'use strict'

const ChildProcessPlugin = require('../src')
const { storage } = require('../../datadog-core')
const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan } = require('../../dd-trace/test/plugins/helpers')

function noop () {}

function normalizeArgs (methodName, command, options) {
  const args = []
  if (methodName === 'exec' || methodName === 'execSync') {
    args.push(command.join(' '))
  } else {
    args.push(command[0], command.slice(1))
  }

  args.push(options)

  return args
}

describe('Child process plugin', () => {
  describe('unit tests', () => {
    let tracerStub, configStub, spanStub

    beforeEach(() => {
      spanStub = {
        setTag: sinon.stub(),
        finish: sinon.stub()
      }

      tracerStub = {
        startSpan: sinon.stub()
      }

      configStub = {
        service: 'test-service'
      }
    })

    afterEach(() => {
      sinon.restore()
    })

    describe('start', () => {
      it('should call startSpan with proper parameters', () => {
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.start({ command: 'ls -l' })

        expect(tracerStub.startSpan).to.have.been.calledOnceWithExactly(
          'command_execution',
          {
            childOf: undefined,
            tags: {
              component: 'subprocess',
              'service.name': 'test-service',
              'resource.name': 'ls',
              'span.kind': undefined,
              'span.type': 'system',
              'cmd.exec': JSON.stringify(['ls', '-l'])
            },
            integrationName: 'child_process',
            links: undefined
          }
        )
      })

      it('should call startSpan with cmd.shell property', () => {
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.start({ command: 'ls -l', shell: true })

        expect(tracerStub.startSpan).to.have.been.calledOnceWithExactly(
          'command_execution',
          {
            childOf: undefined,
            tags: {
              component: 'subprocess',
              'service.name': 'test-service',
              'resource.name': 'sh',
              'span.kind': undefined,
              'span.type': 'system',
              'cmd.shell': 'ls -l'
            },
            integrationName: 'child_process',
            links: undefined
          }
        )
      })

      it('should truncate last argument', () => {
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)
        const arg = 'a'.padEnd(4092, 'a')
        const command = 'echo' + ' ' + arg + ' arg2'

        shellPlugin.start({ command })

        expect(tracerStub.startSpan).to.have.been.calledOnceWithExactly(
          'command_execution',
          {
            childOf: undefined,
            tags: {
              component: 'subprocess',
              'service.name': 'test-service',
              'resource.name': 'echo',
              'span.kind': undefined,
              'span.type': 'system',
              'cmd.exec': JSON.stringify(['echo', arg, '']),
              'cmd.truncated': 'true'
            },
            integrationName: 'child_process',
            links: undefined
          }
        )
      })

      it('should truncate path and blank last argument', () => {
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)
        const path = '/home/'.padEnd(4096, '/')
        const command = 'ls -l' + ' ' + path + ' -t'

        shellPlugin.start({ command, shell: true })

        expect(tracerStub.startSpan).to.have.been.calledOnceWithExactly(
          'command_execution',
          {
            childOf: undefined,
            tags: {
              component: 'subprocess',
              'service.name': 'test-service',
              'resource.name': 'sh',
              'span.kind': undefined,
              'span.type': 'system',
              'cmd.shell': 'ls -l /h ',
              'cmd.truncated': 'true'
            },
            integrationName: 'child_process',
            links: undefined
          }
        )
      })

      it('should truncate first argument and blank the rest', () => {
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)
        const option = '-l'.padEnd(4096, 't')
        const path = '/home'
        const command = `ls ${option} ${path} -t`

        shellPlugin.start({ command })

        expect(tracerStub.startSpan).to.have.been.calledOnceWithExactly(
          'command_execution',
          {
            childOf: undefined,
            tags: {
              component: 'subprocess',
              'service.name': 'test-service',
              'resource.name': 'ls',
              'span.kind': undefined,
              'span.type': 'system',
              'cmd.exec': JSON.stringify(['ls', '-l', '', '']),
              'cmd.truncated': 'true'
            },
            integrationName: 'child_process',
            links: undefined
          }
        )
      })

      it('should truncate last argument', () => {
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)
        const option = '-t'.padEnd(4000 * 8, 'u')
        const path = '/home'
        const command = 'ls' + ' -l' + ' ' + path + ' ' + option

        shellPlugin.start({ command, shell: true })

        expect(tracerStub.startSpan).to.have.been.calledOnceWithExactly(
          'command_execution',
          {
            childOf: undefined,
            tags: {
              component: 'subprocess',
              'service.name': 'test-service',
              'resource.name': 'sh',
              'span.kind': undefined,
              'span.type': 'system',
              'cmd.shell': 'ls -l /home -t',
              'cmd.truncated': 'true'
            },
            integrationName: 'child_process',
            links: undefined
          }
        )
      })

      it('should not crash if command is not a string', () => {
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.start({ command: undefined })

        expect(tracerStub.startSpan).not.to.have.been.called
      })

      it('should not crash if command does not exist', () => {
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.start({})

        expect(tracerStub.startSpan).not.to.have.been.called
      })
    })

    describe('end', () => {
      it('should not call setTag if neither error nor result is passed', () => {
        sinon.stub(storage('legacy'), 'getStore').returns({ span: spanStub })
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.end({})

        expect(spanStub.setTag).not.to.have.been.called
        expect(spanStub.finish).not.to.have.been.called
      })

      it('should call setTag with proper code when result is a buffer', () => {
        sinon.stub(storage('legacy'), 'getStore').returns({ span: spanStub })
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.end({ result: Buffer.from('test') })

        expect(spanStub.setTag).to.have.been.calledOnceWithExactly('cmd.exit_code', '0')
        expect(spanStub.finish).to.have.been.calledOnceWithExactly()
      })

      it('should call setTag with proper code when result is a string', () => {
        sinon.stub(storage('legacy'), 'getStore').returns({ span: spanStub })
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.end({ result: 'test' })

        expect(spanStub.setTag).to.have.been.calledOnceWithExactly('cmd.exit_code', '0')
        expect(spanStub.finish).to.have.been.calledOnceWithExactly()
      })

      it('should call setTag with proper code when an error is thrown', () => {
        sinon.stub(storage('legacy'), 'getStore').returns({ span: spanStub })
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.end({ error: { status: -1 } })

        expect(spanStub.setTag).to.have.been.calledOnceWithExactly('cmd.exit_code', '-1')
        expect(spanStub.finish).to.have.been.calledOnceWithExactly()
      })
    })

    describe('asyncEnd', () => {
      it('should call setTag with undefined code if neither error nor result is passed', () => {
        sinon.stub(storage('legacy'), 'getStore').returns({ span: spanStub })
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.asyncEnd({})

        expect(spanStub.setTag).to.have.been.calledOnceWithExactly('cmd.exit_code', 'undefined')
        expect(spanStub.finish).to.have.been.calledOnce
      })

      it('should call setTag with proper code when a proper code is returned', () => {
        sinon.stub(storage('legacy'), 'getStore').returns({ span: spanStub })
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.asyncEnd({ result: 0 })

        expect(spanStub.setTag).to.have.been.calledOnceWithExactly('cmd.exit_code', '0')
        expect(spanStub.finish).to.have.been.calledOnceWithExactly()
      })
    })

    describe('channel', () => {
      it('should return proper prefix', () => {
        expect(ChildProcessPlugin.prefix).to.be.equal('tracing:datadog:child_process:execution')
      })

      it('should return proper id', () => {
        expect(ChildProcessPlugin.id).to.be.equal('child_process')
      })
    })
  })

  describe('context maintenance', () => {
    let parent
    let childProcess
    let tracer

    before(() => {
      return agent.load(['child_process'])
        .then(() => {
          childProcess = require('child_process')
          tracer = require('../../dd-trace')
          tracer.init()
          parent = tracer.startSpan('parent')
          parent.finish()
        }).then(_port => {
          return new Promise(resolve => setImmediate(resolve))
        })
    })

    after(() => {
      return agent.close()
    })

    it('should preserve context around execSync calls', () => {
      tracer.scope().activate(parent, () => {
        expect(tracer.scope().active()).to.equal(parent)
        childProcess.execSync('ls')
        expect(tracer.scope().active()).to.equal(parent)
      })
    })

    it('should preserve context around exec calls', (done) => {
      tracer.scope().activate(parent, () => {
        expect(tracer.scope().active()).to.equal(parent)
        childProcess.exec('ls', () => {
          expect(tracer.scope().active()).to.equal(parent)
          done()
        })
      })
    })

    it('should preserve context around execFileSync calls', () => {
      tracer.scope().activate(parent, () => {
        expect(tracer.scope().active()).to.equal(parent)
        childProcess.execFileSync('ls')
        expect(tracer.scope().active()).to.equal(parent)
      })
    })

    it('should preserve context around execFile calls', (done) => {
      tracer.scope().activate(parent, () => {
        expect(tracer.scope().active()).to.equal(parent)
        childProcess.execFile('ls', () => {
          expect(tracer.scope().active()).to.equal(parent)
          done()
        })
      })
    })

    it('should preserve context around spawnSync calls', () => {
      tracer.scope().activate(parent, () => {
        expect(tracer.scope().active()).to.equal(parent)
        childProcess.spawnSync('ls')
        expect(tracer.scope().active()).to.equal(parent)
      })
    })

    it('should preserve context around spawn calls', (done) => {
      tracer.scope().activate(parent, () => {
        expect(tracer.scope().active()).to.equal(parent)
        childProcess.spawn('ls')
        expect(tracer.scope().active()).to.equal(parent)
        done()
      })
    })
  })

  describe('Bluebird Promise Compatibility', () => {
    // BLUEBIRD REGRESSION TEST - Prevents "this._then is not a function" bug

    let childProcess, tracer, util
    let originalPromise
    let Bluebird

    beforeEach(() => {
      return agent.load('child_process', undefined, { flushInterval: 1 }).then(() => {
        tracer = require('../../dd-trace')
        childProcess = require('child_process')
        util = require('util')
        tracer.use('child_process', { enabled: true })
        Bluebird = require('../../../versions/bluebird@3.7.2').get()

        // Store original Promise for restoration
        originalPromise = global.Promise
        global.Promise = Bluebird
      })
    })

    afterEach(() => {
      global.Promise = originalPromise
      return agent.close({ ritmReset: false })
    })

    it('should not crash with "this._then is not a function" when using Bluebird promises', (done) => {
      const execFileAsync = util.promisify(childProcess.execFile)

      expect(global.Promise).to.equal(Bluebird)
      expect(global.Promise.version).to.exist

      const expected = {
        type: 'system',
        name: 'command_execution',
        error: 0,
        meta: {
          component: 'subprocess',
          'cmd.exec': '["echo","bluebird-test"]',
        }
      }

      expectSomeSpan(agent, expected).then(done)

      execFileAsync('echo', ['bluebird-test'])
        .then(result => {
          expect(result).to.exist
          expect(result.stdout).to.contain('bluebird-test')
        })
        .catch(done)
    })

    it('should work with concurrent Bluebird promise calls', (done) => {
      const execFileAsync = util.promisify(childProcess.execFile)

      const promises = []
      for (let i = 0; i < 5; i++) {
        promises.push(
          execFileAsync('echo', [`concurrent-test-${i}`])
            .then(result => {
              expect(result.stdout).to.contain(`concurrent-test-${i}`)
              return result
            })
        )
      }

      Promise.all(promises)
        .then(results => {
          expect(results).to.have.length(5)
          done()
        })
        .catch(done)
    })

    it('should handle Bluebird promise rejection properly', (done) => {
      global.Promise = Bluebird

      const execFileAsync = util.promisify(childProcess.execFile)

      const expected = {
        type: 'system',
        name: 'command_execution',
        error: 1,
        meta: {
          component: 'subprocess',
          'cmd.exec': '["node","-invalidFlag"]'
        }
      }

      expectSomeSpan(agent, expected).then(done, done)

      execFileAsync('node', ['-invalidFlag'], { stdio: 'pipe' })
        .then(() => {
          done(new Error('Expected command to fail'))
        })
        .catch(error => {
          expect(error).to.exist
          expect(error.code).to.exist
        })
    })

    it('should work with util.promisify when global Promise is Bluebird', (done) => {
      // Re-require util to get Bluebird-aware promisify
      delete require.cache[require.resolve('util')]
      const utilWithBluebird = require('util')

      const execFileAsync = utilWithBluebird.promisify(childProcess.execFile)

      const promise = execFileAsync('echo', ['util-promisify-test'])
      expect(promise.constructor).to.equal(Bluebird)
      expect(promise.constructor.version).to.exist

      promise
        .then(result => {
          expect(result.stdout).to.contain('util-promisify-test')
          done()
        })
        .catch(done)
    })
  })

  describe('Integration', () => {
    describe('Methods which spawn a shell by default', () => {
      const execAsyncMethods = ['exec']
      const execSyncMethods = ['execSync']
      let childProcess, tracer

      beforeEach(() => {
        return agent.load('child_process', undefined, { flushInterval: 1 }).then(() => {
          tracer = require('../../dd-trace')
          childProcess = require('child_process')
          tracer.use('child_process', { enabled: true })
        })
      })

      afterEach(() => agent.close({ ritmReset: false }))
      const parentSpanList = [true, false]
      parentSpanList.forEach(hasParentSpan => {
        let parentSpan

        describe(`${hasParentSpan ? 'with' : 'without'} parent span`, () => {
          const methods = [
            ...execAsyncMethods.map(methodName => ({ methodName, async: true })),
            ...execSyncMethods.map(methodName => ({ methodName, async: false }))
          ]

          beforeEach((done) => {
            if (hasParentSpan) {
              parentSpan = tracer.startSpan('parent')
              parentSpan.finish()
              tracer.scope().activate(parentSpan, done)
            } else {
              storage('legacy').enterWith({})
              done()
            }
          })

          methods.forEach(({ methodName, async }) => {
            describe(methodName, () => {
              it('should be instrumented', (done) => {
                const expected = {
                  type: 'system',
                  name: 'command_execution',
                  error: 0,
                  meta: {
                    component: 'subprocess',
                    'cmd.shell': 'ls',
                    'cmd.exit_code': '0'
                  }
                }

                expectSomeSpan(agent, expected).then(done, done)

                const res = childProcess[methodName]('ls')
                if (async) {
                  res.on('close', noop)
                }
              })

              it('should maintain previous span after the execution', (done) => {
                const res = childProcess[methodName]('ls')
                const span = storage('legacy').getStore()?.span
                expect(span).to.be.equals(parentSpan)
                if (async) {
                  res.on('close', () => {
                    expect(span).to.be.equals(parentSpan)
                    done()
                  })
                } else {
                  done()
                }
              })

              if (async) {
                it('should maintain previous span in the callback', (done) => {
                  childProcess[methodName]('ls', () => {
                    const span = storage('legacy').getStore()?.span
                    expect(span).to.be.equals(parentSpan)
                    done()
                  })
                })
              }

              it('command should be scrubbed', (done) => {
                const expected = {
                  type: 'system',
                  name: 'command_execution',
                  error: 0,
                  meta: {
                    component: 'subprocess',
                    'cmd.shell': 'echo password ?',
                    'cmd.exit_code': '0'
                  }
                }
                expectSomeSpan(agent, expected).then(done, done)

                const args = []
                if (methodName === 'exec' || methodName === 'execSync') {
                  args.push('echo password 123')
                } else {
                  args.push('echo')
                  args.push(['password', '123'])
                }

                const res = childProcess[methodName](...args)
                if (async) {
                  res.on('close', noop)
                }
              })

              it('should be instrumented with error code', (done) => {
                const command = ['node', '-badOption']
                const options = {
                  stdio: 'pipe'
                }
                const expected = {
                  type: 'system',
                  name: 'command_execution',
                  error: 1,
                  meta: {
                    component: 'subprocess',
                    'cmd.shell': 'node -badOption',
                    'cmd.exit_code': '9'
                  }
                }

                expectSomeSpan(agent, expected).then(done, done)

                const args = normalizeArgs(methodName, command, options)

                if (async) {
                  const res = childProcess[methodName].apply(null, args)
                  res.on('close', noop)
                } else {
                  try {
                    childProcess[methodName].apply(null, args)
                  } catch {
                    // process exit with code 1, exceptions are expected
                  }
                }
              })
            })
          })
        })
      })
    })

    describe('Methods which do not spawn a shell by default', () => {
      const execAsyncMethods = ['execFile', 'spawn']
      const execSyncMethods = ['execFileSync', 'spawnSync']
      let childProcess, tracer

      beforeEach(() => {
        return agent.load('child_process', undefined, { flushInterval: 1 }).then(() => {
          tracer = require('../../dd-trace')
          childProcess = require('child_process')
          tracer.use('child_process', { enabled: true })
        })
      })

      afterEach(() => agent.close({ ritmReset: false }))
      const parentSpanList = [true, false]
      parentSpanList.forEach(parentSpan => {
        describe(`${parentSpan ? 'with' : 'without'} parent span`, () => {
          const methods = [
            ...execAsyncMethods.map(methodName => ({ methodName, async: true })),
            ...execSyncMethods.map(methodName => ({ methodName, async: false }))
          ]
          if (parentSpan) {
            beforeEach((done) => {
              const parentSpan = tracer.startSpan('parent')
              parentSpan.finish()
              tracer.scope().activate(parentSpan, done)
            })
          }

          methods.forEach(({ methodName, async }) => {
            describe(methodName, () => {
              it('should be instrumented', (done) => {
                const expected = {
                  type: 'system',
                  name: 'command_execution',
                  error: 0,
                  meta: {
                    component: 'subprocess',
                    'cmd.exec': '["ls"]',
                    'cmd.exit_code': '0'
                  }
                }
                expectSomeSpan(agent, expected).then(done, done)

                const res = childProcess[methodName]('ls')
                if (async) {
                  res.on('close', noop)
                }
              })

              it('command should be scrubbed', (done) => {
                const expected = {
                  type: 'system',
                  name: 'command_execution',
                  error: 0,
                  meta: {
                    component: 'subprocess',
                    'cmd.exec': '["echo","password","?"]',
                    'cmd.exit_code': '0'
                  }
                }
                expectSomeSpan(agent, expected).then(done, done)

                const args = []
                if (methodName === 'exec' || methodName === 'execSync') {
                  args.push('echo password 123')
                } else {
                  args.push('echo')
                  args.push(['password', '123'])
                }

                const res = childProcess[methodName](...args)
                if (async) {
                  res.on('close', noop)
                }
              })

              it('should be instrumented with error code', (done) => {
                const command = ['node', '-badOption']
                const options = {
                  stdio: 'pipe'
                }

                const errorExpected = {
                  type: 'system',
                  name: 'command_execution',
                  error: 1,
                  meta: {
                    component: 'subprocess',
                    'cmd.exec': '["node","-badOption"]',
                    'cmd.exit_code': '9'
                  }
                }

                const noErrorExpected = {
                  type: 'system',
                  name: 'command_execution',
                  error: 0,
                  meta: {
                    component: 'subprocess',
                    'cmd.exec': '["node","-badOption"]',
                    'cmd.exit_code': '9'
                  }
                }

                const args = normalizeArgs(methodName, command, options)

                if (async) {
                  expectSomeSpan(agent, errorExpected).then(done, done)
                  const res = childProcess[methodName].apply(null, args)
                  res.on('close', noop)
                } else {
                  try {
                    if (methodName === 'spawnSync') {
                      expectSomeSpan(agent, noErrorExpected).then(done, done)
                    } else {
                      expectSomeSpan(agent, errorExpected).then(done, done)
                    }
                    childProcess[methodName].apply(null, args)
                  } catch {
                    // process exit with code 1, exceptions are expected
                  }
                }
              })

              it('should be instrumented with error code (override shell default behavior)', (done) => {
                const command = ['node', '-badOption']
                const options = {
                  stdio: 'pipe',
                  shell: true
                }

                const errorExpected = {
                  type: 'system',
                  name: 'command_execution',
                  error: 1,
                  meta: {
                    component: 'subprocess',
                    'cmd.shell': 'node -badOption',
                    'cmd.exit_code': '9'
                  }
                }

                const noErrorExpected = {
                  type: 'system',
                  name: 'command_execution',
                  error: 0,
                  meta: {
                    component: 'subprocess',
                    'cmd.shell': 'node -badOption',
                    'cmd.exit_code': '9'
                  }
                }

                const args = normalizeArgs(methodName, command, options)

                if (async) {
                  expectSomeSpan(agent, errorExpected).then(done, done)
                  const res = childProcess[methodName].apply(null, args)
                  res.on('close', noop)
                } else {
                  try {
                    if (methodName === 'spawnSync') {
                      expectSomeSpan(agent, noErrorExpected).then(done, done)
                    } else {
                      expectSomeSpan(agent, errorExpected).then(done, done)
                    }
                    childProcess[methodName].apply(null, args)
                  } catch {
                    // process exit with code 1, exceptions are expected
                  }
                }
              })
            })
          })
        })
      })
    })
  })
})
