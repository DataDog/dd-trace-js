'use strict'

const { promisify } = require('util')
const agent = require('../../dd-trace/test/plugins/agent')
const dc = require('dc-polyfill')

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
                  expect(start).to.have.been.calledOnceWith({
                    command: 'ls',
                    file: 'ls',
                    shell: false,
                    abortController: sinon.match.instanceOf(AbortController)
                  })
                  expect(asyncFinish).to.have.been.calledOnceWith({
                    command: 'ls',
                    file: 'ls',
                    shell: false,
                    result: 0
                  })
                  expect(error).not.to.have.been.called
                  done()
                })
              })

              it('should publish arguments', (done) => {
                const childEmitter = childProcess[methodName]('ls', ['-la'])

                childEmitter.once('close', () => {
                  expect(start).to.have.been.calledOnceWith({
                    command: 'ls -la',
                    file: 'ls',
                    fileArgs: ['-la'],
                    shell: false,
                    abortController: sinon.match.instanceOf(AbortController)
                  })
                  expect(asyncFinish).to.have.been.calledOnceWith({
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

                expect(childEmitter.listenerCount('error')).to.equal(methodName.includes('spawn') ? 0 : 1)

                childEmitter.once('error', () => {})

                childEmitter.once('close', () => {
                  expect(start).to.have.been.calledOnceWith({
                    command: 'invalid_command_test',
                    file: 'invalid_command_test',
                    shell: false,
                    abortController: sinon.match.instanceOf(AbortController)
                  })
                  expect(asyncFinish).to.have.been.calledOnceWith({
                    command: 'invalid_command_test',
                    file: 'invalid_command_test',
                    shell: false,
                    result: -2
                  })
                  expect(error).to.have.been.calledOnce
                  done()
                })
              })

              it('should execute error callback with `exit 1` command', (done) => {
                const childEmitter = childProcess[methodName]('node -e "process.exit(1)"', { shell: true })

                childEmitter.once('close', () => {
                  expect(start).to.have.been.calledOnceWith({
                    command: 'node -e "process.exit(1)"',
                    file: 'node -e "process.exit(1)"',
                    abortController: sinon.match.instanceOf(AbortController),
                    shell: true
                  })
                  expect(asyncFinish).to.have.been.calledOnceWith({
                    command: 'node -e "process.exit(1)"',
                    file: 'node -e "process.exit(1)"',
                    shell: true,
                    result: 1
                  })
                  expect(error).to.have.been.calledOnce

                  done()
                })
              })
            })

            if (methodName !== 'spawn') {
              describe(`method ${methodName} with promisify`, () => {
                it('should execute success callbacks', async () => {
                  await promisify(childProcess[methodName])('echo')

                  expect(start.firstCall.firstArg).to.include({
                    command: 'echo',
                    file: 'echo',
                    shell: false
                  })
                  expect(asyncFinish).to.have.been.calledOnceWith({
                    command: 'echo',
                    file: 'echo',
                    shell: false,
                    result: {
                      stdout: '\n',
                      stderr: ''
                    }
                  })
                  expect(error).not.to.have.been.called
                })

                it('should execute error callback', async () => {
                  try {
                    await promisify(childProcess[methodName])('invalid_command_test')
                  } catch (e) {
                    expect(start).to.have.been.calledOnce
                    expect(start.firstCall.firstArg).to.include({ command: 'invalid_command_test', shell: false })

                    const errStub = new Error('spawn invalid_command_test ENOENT')
                    errStub.code = 'ENOENT'
                    errStub.errno = -2

                    expect(asyncFinish).to.have.been.calledOnce
                    expect(asyncFinish.firstCall.firstArg).to.include({ command: 'invalid_command_test', shell: false })
                    expect(asyncFinish.firstCall.firstArg).to.deep.include({
                      command: 'invalid_command_test',
                      shell: false,
                      error: errStub
                    })

                    expect(error).to.have.been.calledOnce
                  }
                })

                it('should execute error callback with `exit 1` command', async () => {
                  const errStub = new Error('Command failed: node -e "process.exit(1)"\n')
                  errStub.code = 1
                  errStub.cmd = 'node -e "process.exit(1)"'

                  try {
                    await promisify(childProcess[methodName])('node -e "process.exit(1)"', { shell: true })
                  } catch (e) {
                    expect(start).to.have.been.calledOnce
                    expect(start.firstCall.firstArg).to.include({ command: 'node -e "process.exit(1)"', shell: true })

                    expect(asyncFinish).to.have.been.calledOnce
                    expect(asyncFinish.firstCall.firstArg).to.include({
                      command: 'node -e "process.exit(1)"',
                      shell: true
                    })
                    expect(asyncFinish.firstCall.firstArg).to.deep.include({
                      command: 'node -e "process.exit(1)"',
                      shell: true,
                      error: errStub
                    })

                    expect(error).to.have.been.calledOnce
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
                  expect(start).to.have.been.calledOnceWith({
                    command: 'ls',
                    file: 'ls',
                    shell: true,
                    abortController: sinon.match.instanceOf(AbortController)
                  })
                  expect(asyncFinish).to.have.been.calledOnceWith({ command: 'ls', file: 'ls', shell: true, result: 0 })
                  expect(error).not.to.have.been.called
                  done()
                })
              })

              it('should execute error callback with `exit 1` command', (done) => {
                const res = childProcess[methodName]('node -e "process.exit(1)"')

                res.once('close', () => {
                  expect(start).to.have.been.calledOnceWith({
                    command: 'node -e "process.exit(1)"',
                    file: 'node -e "process.exit(1)"',
                    abortController: sinon.match.instanceOf(AbortController),
                    shell: true
                  })
                  expect(asyncFinish).to.have.been.calledOnceWith({
                    command: 'node -e "process.exit(1)"',
                    file: 'node -e "process.exit(1)"',
                    shell: true,
                    result: 1
                  })
                  expect(error).to.have.been.called
                  done()
                })
              })

              it('should execute error callback', (done) => {
                const res = childProcess[methodName]('invalid_command_test')

                res.once('close', () => {
                  expect(start).to.have.been.calledOnceWith({
                    command: 'invalid_command_test',
                    file: 'invalid_command_test',
                    abortController: sinon.match.instanceOf(AbortController),
                    shell: true
                  })
                  expect(error).to.have.been.calledOnce
                  expect(asyncFinish).to.have.been.calledOnceWith({
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
                expect(start).to.have.been.calledOnceWith({
                  command: 'echo',
                  file: 'echo',
                  abortController: sinon.match.instanceOf(AbortController),
                  shell: true
                })
                expect(asyncFinish).to.have.been.calledOnceWith({
                  command: 'echo',
                  file: 'echo',
                  shell: true,
                  result: 0
                })
                expect(error).not.to.have.been.called
              })

              it('should execute error callback', async () => {
                try {
                  await promisify(childProcess[methodName])('invalid_command_test')
                  return Promise.reject(new Error('Command expected to fail'))
                } catch (e) {
                  expect(start).to.have.been.calledOnceWith({
                    command: 'invalid_command_test',
                    file: 'invalid_command_test',
                    abortController: sinon.match.instanceOf(AbortController),
                    shell: true
                  })
                  expect(asyncFinish).to.have.been.calledOnce
                  expect(error).to.have.been.calledOnce
                }
              })

              it('should execute error callback with `exit 1` command', async () => {
                try {
                  await promisify(childProcess[methodName])('node -e "process.exit(1)"')
                  return Promise.reject(new Error('Command expected to fail'))
                } catch (e) {
                  expect(start).to.have.been.calledOnceWith({
                    command: 'node -e "process.exit(1)"',
                    file: 'node -e "process.exit(1)"',
                    abortController: sinon.match.instanceOf(AbortController),
                    shell: true
                  })
                  expect(asyncFinish).to.have.been.calledOnceWith({
                    command: 'node -e "process.exit(1)"',
                    file: 'node -e "process.exit(1)"',
                    shell: true,
                    result: 1
                  })
                  expect(error).to.have.been.calledOnce
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
                  expect(error).to.be.equal(abortError)

                  done()
                })
              })

              it('should emit error and close', (done) => {
                const cp = childProcess[methodName]('aborted_command')
                const errorCallback = sinon.stub()

                cp.on('error', errorCallback)
                cp.on('close', () => {
                  expect(errorCallback).to.have.been.calledWithExactly(abortError)
                  done()
                })
              })

              it('should emit error and close and execute the callback', (done) => {
                const callback = sinon.stub()
                const errorCallback = sinon.stub()
                const cp = childProcess[methodName]('aborted_command', callback)

                cp.on('error', errorCallback)
                cp.on('close', () => {
                  expect(callback).to.have.been.calledWithExactly(abortError)
                  expect(errorCallback).to.have.been.calledWithExactly(abortError)

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

                expect(start).to.have.been.calledOnceWith({
                  command: 'ls',
                  file: 'ls',
                  shell: false,
                  abortController: sinon.match.instanceOf(AbortController)
                },
                'tracing:datadog:child_process:execution:start')

                expect(finish).to.have.been.calledOnceWith({
                  command: 'ls',
                  file: 'ls',
                  shell: false,
                  result
                },
                'tracing:datadog:child_process:execution:end')

                expect(error).not.to.have.been.called
              })

              it('should publish arguments', () => {
                const result = childProcess[methodName]('ls', ['-la'])

                expect(start).to.have.been.calledOnceWith({
                  command: 'ls -la',
                  file: 'ls',
                  shell: false,
                  fileArgs: ['-la'],
                  abortController: sinon.match.instanceOf(AbortController)
                })
                expect(finish).to.have.been.calledOnceWith({
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
                    expect(start).to.have.been.calledOnceWith({
                      ...expectedContext,
                      abortController: sinon.match.instanceOf(AbortController)
                    })
                    expect(finish).to.have.been.calledOnceWith({
                      ...expectedContext,
                      error: childError
                    })
                    expect(error).to.have.been.calledOnceWith({
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
                    expect(start).to.have.been.calledOnceWith({
                      ...expectedContext,
                      abortController: sinon.match.instanceOf(AbortController)
                    })
                    expect(finish).to.have.been.calledOnceWith({
                      ...expectedContext,
                      error: childError
                    })
                  }
                })

                it('should execute error callback with `exit 1` command with shell: true', () => {
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
                    expect(start).to.have.been.calledOnceWith({
                      ...expectedContext,
                      abortController: sinon.match.instanceOf(AbortController)
                    })
                    expect(finish).to.have.been.calledOnceWith({
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
                expect(start).to.have.been.calledOnceWith({
                  ...expectedContext,
                  abortController: sinon.match.instanceOf(AbortController)
                })
                expect(finish).to.have.been.calledOnceWith({
                  ...expectedContext,
                  result
                })
                expect(error).not.to.have.been.called
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
                  expect(start).to.have.been.calledOnceWith({
                    ...expectedContext,
                    abortController: sinon.match.instanceOf(AbortController)
                  })
                  expect(finish).to.have.been.calledOnceWith({
                    ...expectedContext,
                    error: childError
                  })
                  expect(error).to.have.been.calledOnceWith({
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
                  expect(start).to.have.been.calledOnceWith({
                    ...expectedContext,
                    abortController: sinon.match.instanceOf(AbortController)
                  })
                  expect(finish).to.have.been.calledOnceWith({
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
                  expect(e).to.be.equal(abortError)

                  return
                }

                throw new Error('Expected to fail')
              })
            })
          })

          describe('method spawnSync', () => {
            it('should return error field', () => {
              const result = childProcess.spawnSync('aborted_command')

              expect(result).to.be.deep.equal({
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
