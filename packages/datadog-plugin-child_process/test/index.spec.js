'use strict'

const ChildProcessPlugin = require('../src')
const { storage } = require('../../datadog-core')
const agent = require('../../dd-trace/test/plugins/agent')
const { expectSomeSpan } = require('../../dd-trace/test/plugins/helpers')
const { NODE_MAJOR } = require('../../../version')

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
              'service.name': undefined,
              'resource.name': 'ls',
              'span.kind': undefined,
              'span.type': 'system',
              'cmd.exec': JSON.stringify([ 'ls', '-l' ])
            },
            integrationName: 'system'
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
              'service.name': undefined,
              'resource.name': 'sh',
              'span.kind': undefined,
              'span.type': 'system',
              'cmd.shell': 'ls -l'
            },
            integrationName: 'system'
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
              'service.name': undefined,
              'resource.name': 'echo',
              'span.kind': undefined,
              'span.type': 'system',
              'cmd.exec': JSON.stringify([ 'echo', arg, '' ]),
              'cmd.truncated': 'true'
            },
            integrationName: 'system'
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
              'service.name': undefined,
              'resource.name': 'sh',
              'span.kind': undefined,
              'span.type': 'system',
              'cmd.shell': 'ls -l /h ',
              'cmd.truncated': 'true'
            },
            integrationName: 'system'
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
              'service.name': undefined,
              'resource.name': 'ls',
              'span.kind': undefined,
              'span.type': 'system',
              'cmd.exec': JSON.stringify([ 'ls', '-l', '', '' ]),
              'cmd.truncated': 'true'
            },
            integrationName: 'system'
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
              'service.name': undefined,
              'resource.name': 'sh',
              'span.kind': undefined,
              'span.type': 'system',
              'cmd.shell': 'ls -l /home -t',
              'cmd.truncated': 'true'
            },
            integrationName: 'system'
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
        sinon.stub(storage, 'getStore').returns({ span: spanStub })
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.end({})

        expect(spanStub.setTag).not.to.have.been.called
        expect(spanStub.finish).not.to.have.been.called
      })

      it('should call setTag with proper code when result is a buffer', () => {
        sinon.stub(storage, 'getStore').returns({ span: spanStub })
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.end({ result: Buffer.from('test') })

        expect(spanStub.setTag).to.have.been.calledOnceWithExactly('cmd.exit_code', '0')
        expect(spanStub.finish).to.have.been.calledOnceWithExactly()
      })

      it('should call setTag with proper code when result is a string', () => {
        sinon.stub(storage, 'getStore').returns({ span: spanStub })
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.end({ result: 'test' })

        expect(spanStub.setTag).to.have.been.calledOnceWithExactly('cmd.exit_code', '0')
        expect(spanStub.finish).to.have.been.calledOnceWithExactly()
      })

      it('should call setTag with proper code when an error is thrown', () => {
        sinon.stub(storage, 'getStore').returns({ span: spanStub })
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.end({ error: { status: -1 } })

        expect(spanStub.setTag).to.have.been.calledOnceWithExactly('cmd.exit_code', '-1')
        expect(spanStub.finish).to.have.been.calledOnceWithExactly()
      })
    })

    describe('asyncEnd', () => {
      it('should call setTag with undefined code if neither error nor result is passed', () => {
        sinon.stub(storage, 'getStore').returns({ span: spanStub })
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.asyncEnd({})

        expect(spanStub.setTag).to.have.been.calledOnceWithExactly('cmd.exit_code', 'undefined')
        expect(spanStub.finish).to.have.been.calledOnce
      })

      it('should call setTag with proper code when a proper code is returned', () => {
        sinon.stub(storage, 'getStore').returns({ span: spanStub })
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
                const command = [ 'node', '-badOption' ]
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
                const command = [ 'node', '-badOption' ]
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

              if (methodName !== 'execFileSync' || NODE_MAJOR > 16) {
                // when a process return an invalid code, in node <=16, in execFileSync with shell:true
                // an exception is not thrown
                it('should be instrumented with error code (override shell default behavior)', (done) => {
                  const command = [ 'node', '-badOption' ]
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
              }
            })
          })
        })
      })
    })
  })
})
