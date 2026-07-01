'use strict'

const assert = require('node:assert/strict')
const events = require('node:events')
const { inspect } = require('node:util')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { storage } = require('../../datadog-core')
const agent = require('../../dd-trace/test/plugins/agent')
const { compare } = require('../../dd-trace/test/plugins/helpers')
const { temporaryWarningExceptions } = require('../../dd-trace/test/setup/core')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const ChildProcessPlugin = require('../src')

const COMMAND_SPAN_TIMEOUT = 4000

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

function getTestMarker (...parts) {
  return ['dd-child-process', ...parts].join('-')
}

function isCommandExecutionSpan (span) {
  return span.name === 'command_execution' && span.meta?.component === 'subprocess'
}

function matchesExpectedCommand (span, expected) {
  const expectedMeta = expected.meta
  if (expectedMeta === undefined || expectedMeta === null || typeof expectedMeta !== 'object') {
    return true
  }

  if (Object.hasOwn(expectedMeta, 'cmd.exec') && span.meta?.['cmd.exec'] !== expectedMeta['cmd.exec']) {
    return false
  }

  if (Object.hasOwn(expectedMeta, 'cmd.shell') && span.meta?.['cmd.shell'] !== expectedMeta['cmd.shell']) {
    return false
  }

  return true
}

/**
 * Waits for the child_process span under test instead of letting parent/manual
 * spans from shared agent payloads become assertion candidates.
 *
 * @param {Record<string, unknown>} expected expected span fields
 * @param {number} [timeout] timeout in milliseconds
 * @returns {Promise<void>}
 */
function expectCommandSpan (expected, timeout = COMMAND_SPAN_TIMEOUT) {
  return agent.assertSomeTraces(traces => {
    const commandSpans = []
    const matchingCommandSpans = []
    const scoredErrors = []

    for (const trace of traces) {
      for (const span of trace) {
        if (!isCommandExecutionSpan(span)) continue

        commandSpans.push(span)
        if (!matchesExpectedCommand(span, expected)) continue

        matchingCommandSpans.push(span)

        try {
          assertObjectContains(span, expected)
          return
        } catch (err) {
          scoredErrors.push({ err, score: compare(expected, span) })
        }
      }
    }

    if (scoredErrors.length > 0) {
      const error = scoredErrors.sort((a, b) => a.score - b.score)[0].err
      error.message += '\n\nCandidate Child Process Spans:\n' + inspect(matchingCommandSpans)
      throw error
    }

    throw new assert.AssertionError({
      message: 'No matching child_process command_execution span found\n\nCandidate Child Process Spans:\n' +
        inspect(commandSpans),
    })
  }, { timeoutMs: timeout })
}

describe('Child process plugin', () => {
  describe('unit tests', () => {
    let tracerStub, configStub, spanStub

    beforeEach(() => {
      spanStub = {
        setTag: sinon.stub(),
        finish: sinon.stub(),
      }

      tracerStub = {
        startSpan: sinon.stub().returns(spanStub),
      }

      configStub = {
        service: 'test-service',
      }
    })

    afterEach(() => {
      sinon.restore()
    })

    describe('start', () => {
      it('should call startSpan with proper parameters', () => {
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.start({ command: 'ls -l' })

        sinon.assert.calledOnceWithExactly(tracerStub.startSpan,
          'command_execution',
          {
            startTime: undefined,
            childOf: undefined,
            tags: {
              component: 'subprocess',
              'service.name': 'test-service',
              'resource.name': 'ls',
              'span.kind': undefined,
              'span.type': 'system',
              '_dd.svc_src': 'opt.plugin',
              'cmd.exec': JSON.stringify(['ls', '-l']),
            },
            integrationName: 'child_process',
            links: undefined,
          }
        )
      })

      it('should call startSpan with cmd.shell property', () => {
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.start({ command: 'ls -l', shell: true })

        sinon.assert.calledOnceWithExactly(tracerStub.startSpan,
          'command_execution',
          {
            startTime: undefined,
            childOf: undefined,
            tags: {
              component: 'subprocess',
              'service.name': 'test-service',
              'resource.name': 'sh',
              'span.kind': undefined,
              'span.type': 'system',
              '_dd.svc_src': 'opt.plugin',
              'cmd.shell': 'ls -l',
            },
            integrationName: 'child_process',
            links: undefined,
          }
        )
      })

      it('should truncate last argument', () => {
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)
        const arg = 'a'.padEnd(4092, 'a')
        const command = 'echo' + ' ' + arg + ' arg2'

        shellPlugin.start({ command })

        sinon.assert.calledOnceWithExactly(tracerStub.startSpan,
          'command_execution',
          {
            startTime: undefined,
            childOf: undefined,
            tags: {
              component: 'subprocess',
              'service.name': 'test-service',
              'resource.name': 'echo',
              'span.kind': undefined,
              'span.type': 'system',
              'cmd.exec': JSON.stringify(['echo', arg, '']),
              '_dd.svc_src': 'opt.plugin',
              'cmd.truncated': 'true',
            },
            integrationName: 'child_process',
            links: undefined,
          }
        )
      })

      it('should truncate path and blank last argument', () => {
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)
        const path = '/home/'.padEnd(4096, '/')
        const command = 'ls -l' + ' ' + path + ' -t'

        shellPlugin.start({ command, shell: true })

        sinon.assert.calledOnceWithExactly(tracerStub.startSpan,
          'command_execution',
          {
            startTime: undefined,
            childOf: undefined,
            tags: {
              component: 'subprocess',
              'service.name': 'test-service',
              'resource.name': 'sh',
              'span.kind': undefined,
              'span.type': 'system',
              'cmd.shell': 'ls -l /h ',
              '_dd.svc_src': 'opt.plugin',
              'cmd.truncated': 'true',
            },
            integrationName: 'child_process',
            links: undefined,
          }
        )
      })

      it('should truncate first argument and blank the rest', () => {
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)
        const option = '-l'.padEnd(4096, 't')
        const path = '/home'
        const command = `ls ${option} ${path} -t`

        shellPlugin.start({ command })

        sinon.assert.calledOnceWithExactly(tracerStub.startSpan,
          'command_execution',
          {
            startTime: undefined,
            childOf: undefined,
            tags: {
              component: 'subprocess',
              'service.name': 'test-service',
              'resource.name': 'ls',
              'span.kind': undefined,
              'span.type': 'system',
              'cmd.exec': JSON.stringify(['ls', '-l', '', '']),
              '_dd.svc_src': 'opt.plugin',
              'cmd.truncated': 'true',
            },
            integrationName: 'child_process',
            links: undefined,
          }
        )
      })

      it('should truncate last argument', () => {
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)
        const option = '-t'.padEnd(4000 * 8, 'u')
        const path = '/home'
        const command = 'ls' + ' -l' + ' ' + path + ' ' + option

        shellPlugin.start({ command, shell: true })

        sinon.assert.calledOnceWithExactly(tracerStub.startSpan,
          'command_execution',
          {
            startTime: undefined,
            childOf: undefined,
            tags: {
              component: 'subprocess',
              'service.name': 'test-service',
              'resource.name': 'sh',
              'span.kind': undefined,
              'span.type': 'system',
              'cmd.shell': 'ls -l /home -t',
              '_dd.svc_src': 'opt.plugin',
              'cmd.truncated': 'true',
            },
            integrationName: 'child_process',
            links: undefined,
          }
        )
      })

      it('should not crash if command is not a string', () => {
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.start({ command: undefined })

        sinon.assert.notCalled(tracerStub.startSpan)
      })

      it('should not crash if command does not exist', () => {
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.start({})

        sinon.assert.notCalled(tracerStub.startSpan)
      })
    })

    describe('end', () => {
      it('should not call setTag if neither error nor result is passed', () => {
        sinon.stub(storage('legacy'), 'getStore').returns({ span: spanStub })
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.end({})

        sinon.assert.notCalled(spanStub.setTag)
        sinon.assert.notCalled(spanStub.finish)
      })

      it('should call setTag with proper code when result is a buffer', () => {
        sinon.stub(storage('legacy'), 'getStore').returns({ span: spanStub })
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.end({ result: Buffer.from('test') })

        sinon.assert.calledOnceWithExactly(spanStub.setTag, 'cmd.exit_code', '0')
        sinon.assert.calledOnceWithExactly(spanStub.finish)
      })

      it('should call setTag with proper code when result is a string', () => {
        sinon.stub(storage('legacy'), 'getStore').returns({ span: spanStub })
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.end({ result: 'test' })

        sinon.assert.calledOnceWithExactly(spanStub.setTag, 'cmd.exit_code', '0')
        sinon.assert.calledOnceWithExactly(spanStub.finish)
      })

      it('should call setTag with proper code when an error is thrown', () => {
        sinon.stub(storage('legacy'), 'getStore').returns({ span: spanStub })
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.end({ error: { status: -1 } })

        sinon.assert.calledOnceWithExactly(spanStub.setTag, 'cmd.exit_code', '-1')
        sinon.assert.calledOnceWithExactly(spanStub.finish)
      })
    })

    describe('asyncEnd', () => {
      it('should call setTag with undefined code if neither error nor result is passed', () => {
        sinon.stub(storage('legacy'), 'getStore').returns({ span: spanStub })
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.asyncEnd({})

        sinon.assert.calledOnceWithExactly(spanStub.setTag, 'cmd.exit_code', 'undefined')
        sinon.assert.calledOnce(spanStub.finish)
      })

      it('should call setTag with proper code when a proper code is returned', () => {
        sinon.stub(storage('legacy'), 'getStore').returns({ span: spanStub })
        const shellPlugin = new ChildProcessPlugin(tracerStub, configStub)

        shellPlugin.asyncEnd({ result: 0 })

        sinon.assert.calledOnceWithExactly(spanStub.setTag, 'cmd.exit_code', '0')
        sinon.assert.calledOnceWithExactly(spanStub.finish)
      })
    })

    describe('channel', () => {
      it('should return proper prefix', () => {
        assert.strictEqual(ChildProcessPlugin.prefix, 'tracing:datadog:child_process:execution')
      })

      it('should return proper id', () => {
        assert.strictEqual(ChildProcessPlugin.id, 'child_process')
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
        assert.strictEqual(tracer.scope().active(), parent)
        childProcess.execSync('ls')
        assert.strictEqual(tracer.scope().active(), parent)
      })
    })

    it('should preserve context around exec calls', (done) => {
      tracer.scope().activate(parent, () => {
        assert.strictEqual(tracer.scope().active(), parent)
        childProcess.exec('ls', () => {
          assert.strictEqual(tracer.scope().active(), parent)
          done()
        })
      })
    })

    it('should preserve context around execFileSync calls', () => {
      tracer.scope().activate(parent, () => {
        assert.strictEqual(tracer.scope().active(), parent)
        childProcess.execFileSync('ls')
        assert.strictEqual(tracer.scope().active(), parent)
      })
    })

    it('should preserve context around execFile calls', (done) => {
      tracer.scope().activate(parent, () => {
        assert.strictEqual(tracer.scope().active(), parent)
        childProcess.execFile('ls', () => {
          assert.strictEqual(tracer.scope().active(), parent)
          done()
        })
      })
    })

    it('should preserve context around spawnSync calls', () => {
      tracer.scope().activate(parent, () => {
        assert.strictEqual(tracer.scope().active(), parent)
        childProcess.spawnSync('ls')
        assert.strictEqual(tracer.scope().active(), parent)
      })
    })

    it('should preserve context around spawn calls', (done) => {
      tracer.scope().activate(parent, () => {
        assert.strictEqual(tracer.scope().active(), parent)
        childProcess.spawn('ls')
        assert.strictEqual(tracer.scope().active(), parent)
        done()
      })
    })
  })

  describe('Bluebird Promise Compatibility', () => {
    // BLUEBIRD REGRESSION TEST - Prevents "this._then is not a function" bug

    let childProcess, tracer, util
    let originalPromise
    let Bluebird

    before(async () => {
      tracer = await agent.load('child_process', undefined, { flushInterval: 1 })
      childProcess = require('child_process')
      util = require('util')
      tracer.use('child_process', { enabled: true })
      Bluebird = require('../../../versions/bluebird').get()
    })

    after(() => agent.close())

    beforeEach(() => {
      originalPromise = global.Promise
      global.Promise = Bluebird
    })

    afterEach(() => {
      global.Promise = originalPromise
    })

    it('should not crash with "this._then is not a function" when using Bluebird promises', async () => {
      const execFileAsync = util.promisify(childProcess.execFile)

      assert.strictEqual(global.Promise, Bluebird)
      assert.ok(global.Promise.version)

      const expectedPromise = expectCommandSpan({
        type: 'system',
        name: 'command_execution',
        error: 0,
        meta: {
          component: 'subprocess',
          'cmd.exec': '["echo","bluebird-test"]',
        },
      })

      const result = await execFileAsync('echo', ['bluebird-test'])
      assert.ok(result)
      assert.strictEqual(result.stdout, 'bluebird-test\n')

      return expectedPromise
    })

    it('should work with concurrent Bluebird promise calls', async () => {
      const execFileAsync = util.promisify(childProcess.execFile)

      const promises = []
      for (let i = 0; i < 5; i++) {
        promises.push(
          execFileAsync('echo', [`concurrent-test-${i}`])
            .then(result => {
              assert.strictEqual(result.stdout, `concurrent-test-${i}\n`)
              return result
            })
        )
      }

      const results = await Promise.all(promises)
      assert.strictEqual(results.length, 5)
    })

    it('should handle Bluebird promise rejection properly', async () => {
      global.Promise = Bluebird

      const execFileAsync = util.promisify(childProcess.execFile)

      const expectedPromise = expectCommandSpan({
        type: 'system',
        name: 'command_execution',
        error: 1,
        meta: {
          component: 'subprocess',
          'cmd.exec': '["node","-invalidFlag"]',
        },
      })

      try {
        await execFileAsync('node', ['-invalidFlag'], { stdio: 'pipe' })
        throw new Error('Expected command to fail')
      } catch (error) {
        assert.ok(error)
        assert.ok(error.code)
      }

      return expectedPromise
    })

    it('should work with util.promisify when global Promise is Bluebird', async () => {
      // Re-require util to get Bluebird-aware promisify
      delete require.cache[require.resolve('util')]
      const utilWithBluebird = require('util')

      const execFileAsync = utilWithBluebird.promisify(childProcess.execFile)

      const promise = execFileAsync('echo', ['util-promisify-test'])
      assert.strictEqual(promise.constructor, Bluebird)
      assert.ok(promise.constructor.version)

      const result = await promise
      assert.strictEqual(result.stdout, 'util-promisify-test\n')
    })
  })

  describe('Integration', () => {
    describe('Methods which spawn a shell by default', () => {
      const execAsyncMethods = ['exec']
      const execSyncMethods = ['execSync']
      let childProcess, tracer

      before(async () => {
        tracer = await agent.load('child_process', undefined, { flushInterval: 1 })
        childProcess = require('child_process')
        tracer.use('child_process', { enabled: true })
      })

      after(() => agent.close())

      const parentSpanList = [true, false]
      parentSpanList.forEach(hasParentSpan => {
        let parentSpan

        describe(`${hasParentSpan ? 'with' : 'without'} parent span`, () => {
          const methods = [
            ...execAsyncMethods.map(methodName => ({ methodName, async: true })),
            ...execSyncMethods.map(methodName => ({ methodName, async: false })),
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
              const markerPrefix = getTestMarker('shell', hasParentSpan ? 'parent' : 'root', methodName)

              function getExpectedShellSpan (command) {
                return {
                  type: 'system',
                  name: 'command_execution',
                  error: 0,
                  meta: {
                    component: 'subprocess',
                    'cmd.shell': command,
                    'cmd.exit_code': '0',
                  },
                }
              }

              it('should be instrumented', (done) => {
                const command = `echo ${markerPrefix}-instrumented`
                expectCommandSpan(getExpectedShellSpan(command)).then(done, done)

                const res = childProcess[methodName](command)
                if (async) {
                  res.on('close', noop)
                }
              })

              it('should maintain previous span after the execution', async () => {
                const command = `echo ${markerPrefix}-maintain`
                const drained = expectCommandSpan(getExpectedShellSpan(command))

                const res = childProcess[methodName](command)
                assert.strictEqual(storage('legacy').getStore()?.span, parentSpan)
                if (async) {
                  await Promise.all([drained, (async () => {
                    await events.once(res, 'close')
                    assert.strictEqual(storage('legacy').getStore()?.span, parentSpan)
                  })()])
                } else {
                  await drained
                }
              })

              if (async) {
                it('should maintain previous span in the callback', async () => {
                  const command = `echo ${markerPrefix}-callback`
                  await Promise.all([expectCommandSpan(getExpectedShellSpan(command)), new Promise(resolve => {
                    childProcess[methodName](command, () => {
                      assert.strictEqual(storage('legacy').getStore()?.span, parentSpan)
                      resolve()
                    })
                  })])
                })
              }

              it('command should be scrubbed', (done) => {
                const marker = `${markerPrefix}-scrubbed`
                const expected = {
                  type: 'system',
                  name: 'command_execution',
                  error: 0,
                  meta: {
                    component: 'subprocess',
                    'cmd.shell': `echo password ? ${marker}`,
                    'cmd.exit_code': '0',
                  },
                }
                expectCommandSpan(expected).then(done, done)

                const args = []
                if (methodName === 'exec' || methodName === 'execSync') {
                  args.push(`echo password 123 ${marker}`)
                } else {
                  args.push('echo')
                  args.push(['password', '123', marker])
                }

                const res = childProcess[methodName](...args)
                if (async) {
                  res.on('close', noop)
                }
              })

              it('should be instrumented with error code', (done) => {
                const command = ['node', `-badOption-${markerPrefix}-error`]
                const options = {
                  stdio: 'pipe',
                }
                const expected = {
                  type: 'system',
                  name: 'command_execution',
                  error: 1,
                  meta: {
                    component: 'subprocess',
                    'cmd.shell': command.join(' '),
                    'cmd.exit_code': '9',
                  },
                }

                expectCommandSpan(expected).then(done, done)

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

      before(async () => {
        tracer = await agent.load('child_process', undefined, { flushInterval: 1 })
        childProcess = require('child_process')
        tracer.use('child_process', { enabled: true })
      })

      after(() => agent.close())

      const parentSpanList = [true, false]
      parentSpanList.forEach(parentSpan => {
        describe(`${parentSpan ? 'with' : 'without'} parent span`, () => {
          const methods = [
            ...execAsyncMethods.map(methodName => ({ methodName, async: true })),
            ...execSyncMethods.map(methodName => ({ methodName, async: false })),
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
              const markerPrefix = getTestMarker('exec', parentSpan ? 'parent' : 'root', methodName)

              it('should be instrumented', (done) => {
                const marker = `${markerPrefix}-instrumented`
                const expected = {
                  type: 'system',
                  name: 'command_execution',
                  error: 0,
                  meta: {
                    component: 'subprocess',
                    'cmd.exec': JSON.stringify(['echo', marker]),
                    'cmd.exit_code': '0',
                  },
                }
                expectCommandSpan(expected).then(done, done)

                const res = childProcess[methodName]('echo', [marker])
                if (async) {
                  res.on('close', noop)
                }
              })

              it('command should be scrubbed', (done) => {
                const marker = `${markerPrefix}-scrubbed`
                const expected = {
                  type: 'system',
                  name: 'command_execution',
                  error: 0,
                  meta: {
                    component: 'subprocess',
                    'cmd.exec': JSON.stringify(['echo', 'password', '?', marker]),
                    'cmd.exit_code': '0',
                  },
                }
                expectCommandSpan(expected).then(done, done)

                const args = []
                if (methodName === 'exec' || methodName === 'execSync') {
                  args.push(`echo password 123 ${marker}`)
                } else {
                  args.push('echo')
                  args.push(['password', '123', marker])
                }

                const res = childProcess[methodName](...args)
                if (async) {
                  res.on('close', noop)
                }
              })

              it('should be instrumented with error code', (done) => {
                const command = ['node', `-badOption-${markerPrefix}-error`]
                const options = {
                  stdio: 'pipe',
                }

                const errorExpected = {
                  type: 'system',
                  name: 'command_execution',
                  error: 1,
                  meta: {
                    component: 'subprocess',
                    'cmd.exec': JSON.stringify(command),
                    'cmd.exit_code': '9',
                  },
                }

                const noErrorExpected = {
                  type: 'system',
                  name: 'command_execution',
                  error: 0,
                  meta: {
                    component: 'subprocess',
                    'cmd.exec': JSON.stringify(command),
                    'cmd.exit_code': '9',
                  },
                }

                const args = normalizeArgs(methodName, command, options)

                if (async) {
                  expectCommandSpan(errorExpected).then(done, done)
                  const res = childProcess[methodName].apply(null, args)
                  res.on('close', noop)
                } else {
                  try {
                    if (methodName === 'spawnSync') {
                      expectCommandSpan(noErrorExpected).then(done, done)
                    } else {
                      expectCommandSpan(errorExpected).then(done, done)
                    }
                    childProcess[methodName].apply(null, args)
                  } catch {
                    // process exit with code 1, exceptions are expected
                  }
                }
              })

              it('should be instrumented with error code (override shell default behavior)', (done) => {
                const command = ['node', `-badOption-${markerPrefix}-shell-error`]
                const options = {
                  stdio: 'pipe',
                  shell: true,
                }

                const errorExpected = {
                  type: 'system',
                  name: 'command_execution',
                  error: 1,
                  meta: {
                    component: 'subprocess',
                    'cmd.shell': command.join(' '),
                    'cmd.exit_code': '9',
                  },
                }

                const noErrorExpected = {
                  type: 'system',
                  name: 'command_execution',
                  error: 0,
                  meta: {
                    component: 'subprocess',
                    'cmd.shell': command.join(' '),
                    'cmd.exit_code': '9',
                  },
                }

                const args = normalizeArgs(methodName, command, options)

                temporaryWarningExceptions.add(
                  'Passing args to a child process with shell option true can lead to security vulnerabilities, ' +
                    'as the arguments are not escaped, only concatenated.'
                )

                if (async) {
                  expectCommandSpan(errorExpected).then(done, done)
                  const res = childProcess[methodName].apply(null, args)
                  res.on('close', noop)
                } else {
                  try {
                    if (methodName === 'spawnSync') {
                      expectCommandSpan(noErrorExpected).then(done, done)
                    } else {
                      expectCommandSpan(errorExpected).then(done, done)
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
