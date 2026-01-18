'use strict'

const assert = require('node:assert/strict')
const { promisify } = require('node:util')

const dc = require('dc-polyfill')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { temporaryWarningExceptions } = require('../../dd-trace/test/setup/core')

describe('child process', () => {
  const modules = ['child_process', 'node:child_process']
  const execAsyncMethods = ['execFile', 'spawn']
  const execAsyncShellMethods = ['exec']
  const execSyncMethods = ['execFileSync', 'spawnSync']
  const execSyncShellMethods = ['execSync']

  const childProcessChannel = dc.tracingChannel('datadog:child_process:execution')

  modules.forEach((childProcessModuleName) => {
    describe(childProcessModuleName, () => {
      let start, finish, error, childProcess, asyncFinish

      before(() => {
        return agent.load(childProcessModuleName)
      })

      after(() => {
        return agent.close({ ritmReset: false })
      })

      beforeEach(() => {
        start = sinon.stub()
        finish = sinon.stub()
        error = sinon.stub()
        asyncFinish = sinon.stub()

        childProcessChannel.subscribe({
          start,
          end: finish,
          asyncEnd: asyncFinish,
          error
        })

        childProcess = require(childProcessModuleName)
      })

      afterEach(() => {
        childProcessChannel.unsubscribe({
          start,
          end: finish,
          asyncEnd: asyncFinish,
          error
        })
      })

      describe('async methods', () => {
        describe('command not interpreted by a shell by default', () => {
          execAsyncMethods.forEach(methodName => {
            describe(`method ${methodName}`, () => {
              it('should execute success callbacks', (done) => {
                const childEmitter = childProcess[methodName]('ls')

                childEmitter.once('close', () => {
                  sinon.assert.calledOnce(start)
                  sinon.assert.calledWithMatch(start, {
                    command: 'ls',
                    file: 'ls',
                    shell: false,
                    abortController: sinon.match.instanceOf(AbortController)
                  })
                  sinon.assert.calledOnce(asyncFinish)
                  sinon.assert.calledWithMatch(asyncFinish, {
                    command: 'ls',
                    file: 'ls',
                    shell: false,
                    result: 0
                  })
                  sinon.assert.notCalled(error)
                  done()
                })
              })

              it('should publish arguments', (done) => {
                const childEmitter = childProcess[methodName]('ls', ['-la'])

                childEmitter.once('close', () => {
                  sinon.assert.calledOnce(start)
                  sinon.assert.calledWithMatch(start, {
                    command: 'ls -la',
                    file: 'ls',
                    fileArgs: ['-la'],
                    shell: false,
                    abortController: sinon.match.instanceOf(AbortController)
                  })
                  sinon.assert.calledOnce(asyncFinish)
                  sinon.assert.calledWithMatch(asyncFinish, {
                    command: 'ls -la',
                    file: 'ls',
                    shell: false,
                    fileArgs: ['-la'],
                    result: 0
                  })

                  done()
                })
              })

              it('should execute error callback', (done) => {
                const childEmitter = childProcess[methodName]('invalid_command_test')

                assert.strictEqual(childEmitter.listenerCount('error'), methodName.includes('spawn') ? 0 : 1)

                childEmitter.once('error', () => {})

                childEmitter.once('close', () => {
                  sinon.assert.calledOnce(start)
                  sinon.assert.calledWithMatch(start, {
                    command: 'invalid_command_test',
                    file: 'invalid_command_test',
                    shell: false,
                    abortController: sinon.match.instanceOf(AbortController)
                  })
                  sinon.assert.calledOnce(asyncFinish)
                  sinon.assert.calledWithMatch(asyncFinish, {
                    command: 'invalid_command_test',
                    file: 'invalid_command_test',
                    shell: false,
                    result: -2
                  })
                  sinon.assert.calledOnce(error)
                  done()
                })
              })

              it('should execute error callback with `exit 1` command', (done) => {
                const childEmitter = childProcess[methodName]('node -e "process.exit(1)"', { shell: true })

                childEmitter.once('close', () => {
                  sinon.assert.calledOnce(start)
                  sinon.assert.calledWithMatch(start, {
                    command: 'node -e "process.exit(1)"',
                    file: 'node -e "process.exit(1)"',
                    abortController: sinon.match.instanceOf(AbortController),
                    shell: true
                  })
                  sinon.assert.calledOnce(asyncFinish)
                  sinon.assert.calledWithMatch(asyncFinish, {
                    command: 'node -e "process.exit(1)"',
                    file: 'node -e "process.exit(1)"',
                    shell: true,
                    result: 1
                  })
                  sinon.assert.calledOnce(error)

                  done()
                })
              })
            })

            if (methodName !== 'spawn') {
              describe(`method ${methodName} with promisify`, () => {
                it('should execute success callbacks', async () => {
                  await promisify(childProcess[methodName])('echo')

                  assertObjectContains(start.firstCall.firstArg, {
                    command: 'echo',
                    file: 'echo',
                    shell: false
                  })
                  sinon.assert.calledOnce(asyncFinish)
                  sinon.assert.calledWithMatch(asyncFinish, {
                    command: 'echo',
                    file: 'echo',
                    shell: false,
                    result: {
                      stdout: '\n',
                      stderr: ''
                    }
                  })
                  sinon.assert.notCalled(error)
                })

                it('should execute error callback', async () => {
                  try {
                    await promisify(childProcess[methodName])('invalid_command_test')
                  } catch (e) {
                    sinon.assert.calledOnce(start)
                    assertObjectContains(start.firstCall.firstArg, { command: 'invalid_command_test', shell: false })

                    const errStub = new Error('spawn invalid_command_test ENOENT')
                    errStub.code = 'ENOENT'
                    errStub.errno = -2

                    sinon.assert.calledOnce(asyncFinish)
                    assertObjectContains(asyncFinish.firstCall.firstArg, {
                      command: 'invalid_command_test',
                      shell: false
                    })
                    assertObjectContains(asyncFinish.firstCall.firstArg, {
                      command: 'invalid_command_test',
                      shell: false,
                      error: errStub
                    })

                    sinon.assert.calledOnce(error)
                  }
                })

                it('should execute error callback with `exit 1` command', async () => {
                  const errStub = new Error('Command failed: node -e "process.exit(1)"\n')
                  errStub.code = 1
                  errStub.cmd = 'node -e "process.exit(1)"'

                  try {
                    await promisify(childProcess[methodName])('node -e "process.exit(1)"', { shell: true })
                  } catch (e) {
                    sinon.assert.calledOnce(start)
                    assertObjectContains(start.firstCall.firstArg, {
                      command: 'node -e "process.exit(1)"',
                      shell: true
                    })

                    sinon.assert.calledOnce(asyncFinish)
                    assertObjectContains(asyncFinish.firstCall.firstArg, {
                      command: 'node -e "process.exit(1)"',
                      shell: true
                    })
                    assertObjectContains(asyncFinish.firstCall.firstArg, {
                      command: 'node -e "process.exit(1)"',
                      shell: true,
                      error: errStub
                    })

                    sinon.assert.calledOnce(error)
                  }
                })
              })
            }
          })
        })

        describe('command interpreted by a shell by default', () => {
          execAsyncShellMethods.forEach(methodName => {
            describe(`method ${methodName}`, () => {
              it('should execute success callbacks', (done) => {
                const res = childProcess[methodName]('ls')

                res.once('close', () => {
                  sinon.assert.calledOnce(start)
                  sinon.assert.calledWithMatch(start, {
                    command: 'ls',
                    file: 'ls',
                    shell: true,
                    abortController: sinon.match.instanceOf(AbortController)
                  })
                  sinon.assert.calledOnce(asyncFinish)
                  sinon.assert.calledWithMatch(asyncFinish, {
                    command: 'ls',
                    file: 'ls',
                    shell: true,
                    result: 0
                  })
                  sinon.assert.notCalled(error)
                  done()
                })
              })

              it('should execute error callback with `exit 1` command', (done) => {
                const res = childProcess[methodName]('node -e "process.exit(1)"')

                res.once('close', () => {
                  sinon.assert.calledOnce(start)
                  sinon.assert.calledWithMatch(start, {
                    command: 'node -e "process.exit(1)"',
                    file: 'node -e "process.exit(1)"',
                    abortController: sinon.match.instanceOf(AbortController),
                    shell: true
                  })
                  sinon.assert.calledOnce(asyncFinish)
                  sinon.assert.calledWithMatch(asyncFinish, {
                    command: 'node -e "process.exit(1)"',
                    file: 'node -e "process.exit(1)"',
                    shell: true,
                    result: 1
                  })
                  sinon.assert.called(error)
                  done()
                })
              })

              it('should execute error callback', (done) => {
                const res = childProcess[methodName]('invalid_command_test')

                res.once('close', () => {
                  sinon.assert.calledOnce(start)
                  sinon.assert.calledWithMatch(start, {
                    command: 'invalid_command_test',
                    file: 'invalid_command_test',
                    abortController: sinon.match.instanceOf(AbortController),
                    shell: true
                  })
                  sinon.assert.calledOnce(error)
                  sinon.assert.calledOnce(asyncFinish)
                  sinon.assert.calledWithMatch(asyncFinish, {
                    command: 'invalid_command_test',
                    file: 'invalid_command_test',
                    shell: true,
                    result: 127
                  })
                  done()
                })
              })
            })

            describe(`method ${methodName} with promisify`, () => {
              it('should execute success callbacks', async () => {
                await promisify(childProcess[methodName])('echo')
                sinon.assert.calledOnce(start)
                sinon.assert.calledWithMatch(start, {
                  command: 'echo',
                  file: 'echo',
                  abortController: sinon.match.instanceOf(AbortController),
                  shell: true
                })
                sinon.assert.calledOnce(start)
                sinon.assert.calledWithMatch(asyncFinish, {
                  command: 'echo',
                  file: 'echo',
                  shell: true,
                  result: 0
                })
                sinon.assert.notCalled(error)
              })

              it('should execute error callback', async () => {
                try {
                  await promisify(childProcess[methodName])('invalid_command_test')
                  return Promise.reject(new Error('Command expected to fail'))
                } catch (e) {
                  sinon.assert.calledOnce(start)
                  sinon.assert.calledWithMatch(start, {
                    command: 'invalid_command_test',
                    file: 'invalid_command_test',
                    abortController: sinon.match.instanceOf(AbortController),
                    shell: true
                  })
                  sinon.assert.calledOnce(asyncFinish)
                  sinon.assert.calledOnce(error)
                }
              })

              it('should execute error callback with `exit 1` command', async () => {
                try {
                  await promisify(childProcess[methodName])('node -e "process.exit(1)"')
                  return Promise.reject(new Error('Command expected to fail'))
                } catch (e) {
                  sinon.assert.calledOnce(start)
                  sinon.assert.calledWithMatch(start, {
                    command: 'node -e "process.exit(1)"',
                    file: 'node -e "process.exit(1)"',
                    abortController: sinon.match.instanceOf(AbortController),
                    shell: true
                  })
                  sinon.assert.calledOnce(asyncFinish)
                  sinon.assert.calledWithMatch(asyncFinish, {
                    command: 'node -e "process.exit(1)"',
                    file: 'node -e "process.exit(1)"',
                    shell: true,
                    result: 1
                  })
                  sinon.assert.calledOnce(error)
                }
              })
            })
          })
        })

        describe('aborting in abortController', () => {
          const abortError = new Error('AbortError')
          function abort ({ abortController }) {
            abortController.abort(abortError)
          }

          beforeEach(() => {
            childProcessChannel.subscribe({ start: abort })
          })

          afterEach(() => {
            childProcessChannel.unsubscribe({ start: abort })
          })

          ;[...execAsyncMethods, ...execAsyncShellMethods].forEach((methodName) => {
            describe(`method ${methodName}`, () => {
              it('should execute callback with the error', (done) => {
                childProcess[methodName]('aborted_command', (error) => {
                  assert.strictEqual(error, abortError)

                  done()
                })
              })

              it('should emit error and close', (done) => {
                const cp = childProcess[methodName]('aborted_command')
                const errorCallback = sinon.stub()

                cp.on('error', errorCallback)
                cp.on('close', () => {
                  sinon.assert.calledWithExactly(errorCallback, abortError)
                  done()
                })
              })

              it('should emit error and close and execute the callback', (done) => {
                const callback = sinon.stub()
                const errorCallback = sinon.stub()
                const cp = childProcess[methodName]('aborted_command', callback)

                cp.on('error', errorCallback)
                cp.on('close', () => {
                  sinon.assert.calledWithExactly(callback, abortError)
                  sinon.assert.calledWithExactly(errorCallback, abortError)

                  done()
                })
              })
            })
          })
        })
      })

      describe('sync methods', () => {
        describe('command not interpreted by a shell', () => {
          execSyncMethods.forEach(methodName => {
            describe(`method ${methodName}`, () => {
              it('should execute success callbacks', () => {
                const result = childProcess[methodName]('ls')

                sinon.assert.calledOnce(start)
                sinon.assert.calledWithMatch(start, {
                  command: 'ls',
                  file: 'ls',
                  shell: false,
                  abortController: sinon.match.instanceOf(AbortController)
                },
                'tracing:datadog:child_process:execution:start')

                sinon.assert.calledOnce(finish)
                sinon.assert.calledWithMatch(finish, {
                  command: 'ls',
                  file: 'ls',
                  shell: false,
                  result
                },
                'tracing:datadog:child_process:execution:end')

                sinon.assert.notCalled(error)
              })

              it('should publish arguments', () => {
                const result = childProcess[methodName]('ls', ['-la'])

                sinon.assert.calledOnce(start)
                sinon.assert.calledWithMatch(start, {
                  command: 'ls -la',
                  file: 'ls',
                  shell: false,
                  fileArgs: ['-la'],
                  abortController: sinon.match.instanceOf(AbortController)
                })
                sinon.assert.calledOnce(finish)
                sinon.assert.calledWithMatch(finish, {
                  command: 'ls -la',
                  file: 'ls',
                  shell: false,
                  fileArgs: ['-la'],
                  result
                })
              })

              // errors are handled in a different way in spawnSync method
              if (methodName !== 'spawnSync') {
                it('should execute error callback', () => {
                  let childError, result
                  try {
                    result = childProcess[methodName]('invalid_command_test')
                  } catch (error) {
                    childError = error
                  } finally {
                    childError = childError || result?.error

                    const expectedContext = {
                      command: 'invalid_command_test',
                      file: 'invalid_command_test',
                      shell: false
                    }
                    sinon.assert.calledOnce(start)
                    sinon.assert.calledWithMatch(start, {
                      ...expectedContext,
                      abortController: sinon.match.instanceOf(AbortController)
                    })
                    sinon.assert.calledOnce(finish)
                    sinon.assert.calledWithMatch(finish, {
                      ...expectedContext,
                      error: childError
                    })
                    sinon.assert.calledWithMatch(error, {
                      ...expectedContext,
                      error: childError
                    })
                  }
                })

                it('should execute error callback with `exit 1` command', () => {
                  let childError
                  try {
                    childProcess[methodName]('node -e "process.exit(1)"')
                  } catch (error) {
                    childError = error
                  } finally {
                    const expectedContext = {
                      command: 'node -e "process.exit(1)"',
                      file: 'node -e "process.exit(1)"',
                      shell: false
                    }
                    sinon.assert.calledOnce(start)
                    sinon.assert.calledWithMatch(start, {
                      ...expectedContext,
                      abortController: sinon.match.instanceOf(AbortController)
                    })
                    sinon.assert.calledOnce(finish)
                    sinon.assert.calledWithMatch(finish, {
                      ...expectedContext,
                      error: childError
                    })
                  }
                })

                it('should execute error callback with `exit 1` command with shell: true', () => {
                  temporaryWarningExceptions.add(
                    'Passing args to a child process with shell option true can lead to security vulnerabilities, ' +
                      'as the arguments are not escaped, only concatenated.'
                  )
                  let childError
                  try {
                    childProcess[methodName]('node -e "process.exit(1)"', { shell: true })
                  } catch (error) {
                    childError = error
                  } finally {
                    const expectedContext = {
                      command: 'node -e "process.exit(1)"',
                      file: 'node -e "process.exit(1)"',
                      shell: true
                    }
                    sinon.assert.calledOnce(start)
                    sinon.assert.calledWithMatch(start, {
                      ...expectedContext,
                      abortController: sinon.match.instanceOf(AbortController)
                    })
                    sinon.assert.calledOnce(finish)
                    sinon.assert.calledWithMatch(finish, {
                      ...expectedContext,
                      error: childError
                    })
                  }
                })
              }
            })
          })
        })

        describe('command interpreted by a shell by default', () => {
          execSyncShellMethods.forEach(methodName => {
            describe(`method ${methodName}`, () => {
              it('should execute success callbacks', () => {
                const result = childProcess[methodName]('ls')

                const expectedContext = {
                  command: 'ls',
                  file: 'ls',
                  shell: true
                }
                sinon.assert.calledOnce(start)
                sinon.assert.calledWithMatch(start, {
                  ...expectedContext,
                  abortController: sinon.match.instanceOf(AbortController)
                })
                sinon.assert.calledOnce(finish)
                sinon.assert.calledWithMatch(finish, {
                  ...expectedContext,
                  result
                })
                sinon.assert.notCalled(error)
              })

              it('should execute error callback', () => {
                let childError
                try {
                  childProcess[methodName]('invalid_command_test')
                } catch (error) {
                  childError = error
                } finally {
                  const expectedContext = {
                    command: 'invalid_command_test',
                    file: 'invalid_command_test',
                    shell: true
                  }
                  sinon.assert.calledOnce(start)
                  sinon.assert.calledWithMatch(start, {
                    ...expectedContext,
                    abortController: sinon.match.instanceOf(AbortController)
                  })
                  sinon.assert.calledOnce(finish)
                  sinon.assert.calledWithMatch(finish, {
                    ...expectedContext,
                    error: childError
                  })
                  sinon.assert.calledOnce(error)
                  sinon.assert.calledWithMatch(error, {
                    ...expectedContext,
                    error: childError
                  })
                }
              })

              it('should execute error callback with `exit 1` command', () => {
                let childError
                try {
                  childProcess[methodName]('node -e "process.exit(1)"')
                } catch (error) {
                  childError = error
                } finally {
                  const expectedContext = {
                    command: 'node -e "process.exit(1)"',
                    file: 'node -e "process.exit(1)"',
                    shell: true
                  }
                  sinon.assert.calledOnce(start)
                  sinon.assert.calledWithMatch(start, {
                    ...expectedContext,
                    abortController: sinon.match.instanceOf(AbortController)
                  })
                  sinon.assert.calledOnce(finish)
                  sinon.assert.calledWithMatch(finish, {
                    ...expectedContext,
                    error: childError
                  })
                }
              })
            })
          })
        })

        describe('aborting in abortController', () => {
          const abortError = new Error('AbortError')
          function abort ({ abortController }) {
            abortController.abort(abortError)
          }

          beforeEach(() => {
            childProcessChannel.subscribe({ start: abort })
          })

          afterEach(() => {
            childProcessChannel.unsubscribe({ start: abort })
          })

          ;['execFileSync', 'execSync'].forEach((methodName) => {
            describe(`method ${methodName}`, () => {
              it('should throw the expected error', () => {
                try {
                  childProcess[methodName]('aborted_command')
                } catch (e) {
                  assert.strictEqual(e, abortError)

                  return
                }

                throw new Error('Expected to fail')
              })
            })
          })

          describe('method spawnSync', () => {
            it('should return error field', () => {
              const result = childProcess.spawnSync('aborted_command')

              assert.deepStrictEqual(result, {
                error: abortError,
                status: null,
                signal: null,
                output: null,
                stdout: null,
                stderr: null,
                pid: 0
              })
            })
          })
        })
      })
    })
  })
})
