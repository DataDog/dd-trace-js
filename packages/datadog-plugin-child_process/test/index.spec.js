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
    })

    afterEach(() => {
      sinon.restore()
    })

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
            'resource.name': 'ls',
            'span.kind': undefined,
            'span.type': 'system',
            'cmd.shell': JSON.stringify([ 'ls', '-l' ])
          },
          integrationName: 'system'
        }
      )
    })

    it('should truncate path and blank last argument', () => {
      const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)
      const path = '/home/'.padEnd(4000 * 8, '/')
      const command = 'ls -l' + ' ' + path + ' -t'

      shellPlugin.start({ command, shell: true })

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
            'cmd.shell': JSON.stringify([ 'ls', '-l', '/h', '' ])
          },
          integrationName: 'system'
        }
      )
    })

    it('should truncate first argument and blank the rest', () => {
      const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)
      const option = '-l'.padEnd(4000 * 8, 't')
      const path = '/home'
      const command = `ls ${option} ${path} -t`

      shellPlugin.start({ command, shell: true })

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
            'cmd.shell': JSON.stringify([ 'ls', '-l', '', '' ])
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
            'resource.name': 'ls',
            'span.kind': undefined,
            'span.type': 'system',
            'cmd.shell': JSON.stringify([ 'ls', '-l', '/home', '-t' ])
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

    it('should call setTag with proper code', () => {
      sinon.stub(storage, 'getStore').returns({ span: spanStub })
      const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

      shellPlugin.finish({ exitCode: 0 })

      expect(spanStub.setTag).to.have.been.calledOnceWithExactly('cmd.exit_code', '0')
      expect(spanStub.finish).to.have.been.calledOnceWithExactly()
    })

    it('should return proper prefix', () => {
      expect(ChildProcessPlugin.prefix).to.be.equal('datadog:child_process:execution')
    })

    it('should return proper id', () => {
      expect(ChildProcessPlugin.id).to.be.equal('child_process')
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
                    'cmd.shell': '["ls"]',
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
                    'cmd.shell': '["echo","password","?"]',
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
                    'cmd.shell': '["node","-badOption"]',
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
      const execSyncMethods = ['execFile', 'spawnSync']
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
                const expected = {
                  type: 'system',
                  name: 'command_execution',
                  error: 1,
                  meta: {
                    component: 'subprocess',
                    'cmd.exec': '["node","-badOption"]',
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

              it('should be instrumented with error code (override shell default behavior)', (done) => {
                const command = [ 'node', '-badOption' ]
                const options = {
                  stdio: 'pipe',
                  shell: true
                }
                const expected = {
                  type: 'system',
                  name: 'command_execution',
                  error: 1,
                  meta: {
                    component: 'subprocess',
                    'cmd.shell': '["node","-badOption"]',
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
  })
})
