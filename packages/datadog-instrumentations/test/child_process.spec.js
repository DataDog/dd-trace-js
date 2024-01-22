'use strict'

const { promisify } = require('util')
const agent = require('../../dd-trace/test/plugins/agent')
const dc = require('dc-polyfill')

describe('child process', () => {
  const modules = ['child_process', 'node:child_process']
  const execAsyncMethods = ['execFile', 'spawn']
  const execAsyncShellMethods = ['exec']
  const execSyncMethods = ['execFileSync']
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
          start: start,
          end: finish,
          asyncEnd: asyncFinish,
          error: error
        })

        childProcess = require(childProcessModuleName)
      })

      afterEach(() => {
        childProcessChannel.unsubscribe({
          start: start,
          end: finish,
          asyncEnd: asyncFinish,
          error: error
        })
      })

      describe('async methods', (done) => {
        describe('command not interpreted by a shell by default', () => {
          execAsyncMethods.forEach(methodName => {
            describe(`method ${methodName}`, () => {
              it('should execute success callbacks', (done) => {
                const childEmitter = childProcess[methodName]('ls')

                childEmitter.once('close', () => {
                  expect(start).to.have.been.calledOnceWith({ command: 'ls', shell: false })
                  expect(finish).to.have.been.calledOnceWith({ command: 'ls', shell: false, result: 0 })
                  expect(error).not.to.have.been.called
                  done()
                })
              })

              it('should execute error callback', (done) => {
                const childEmitter = childProcess[methodName]('invalid_command_test')

                childEmitter.once('close', () => {
                  expect(start).to.have.been.calledOnceWith({ command: 'invalid_command_test', shell: false })
                  expect(finish).to.have.been.calledOnceWith({
                    command: 'invalid_command_test',
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
                  expect(start).to.have.been.calledOnceWith({ command: 'node -e "process.exit(1)"', shell: true })
                  expect(finish).to.have.been.calledOnceWith({
                    command: 'node -e "process.exit(1)"',
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
                    shell: false
                  })

                  expect(finish).to.have.been.calledOnceWith({
                    command: 'echo',
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

                    expect(finish).to.have.been.calledOnce
                    expect(finish.firstCall.firstArg).to.include({ command: 'invalid_command_test', shell: false })
                    expect(finish.firstCall.firstArg).to.deep.include({
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

                    expect(finish).to.have.been.calledOnce
                    expect(finish.firstCall.firstArg).to.include({ command: 'node -e "process.exit(1)"', shell: true })
                    expect(finish.firstCall.firstArg).to.deep.include({
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
                  expect(start).to.have.been.calledOnceWith({ command: 'ls', shell: true })
                  expect(finish).to.have.been.calledOnceWith({ command: 'ls', shell: true, result: 0 })
                  expect(error).not.to.have.been.called
                  done()
                })
              })

              it('should execute error callback with `exit 1` command', (done) => {
                const res = childProcess[methodName]('node -e "process.exit(1)"')

                res.once('close', () => {
                  expect(start).to.have.been.calledOnceWith({ command: 'node -e "process.exit(1)"', shell: true })
                  expect(finish).to.have.been.calledOnceWith({
                    command: 'node -e "process.exit(1)"',
                    shell: true,
                    result: 1
                  })
                  expect(error).not.to.have.been.called
                  done()
                })
              })

              it('should execute error callback', (done) => {
                const res = childProcess[methodName]('invalid_command_test')

                res.once('close', () => {
                  expect(start).to.have.been.calledOnceWith({ command: 'invalid_command_test', shell: true })
                  expect(error).to.have.been.calledOnce
                  expect(finish).to.have.been.calledOnceWith({
                    command: 'invalid_command_test',
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
                  shell: true
                })
                expect(finish).to.have.been.calledOnceWith({
                  command: 'echo',
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
                  expect(start).to.have.been.calledOnceWith({ command: 'invalid_command_test', shell: true })
                  expect(finish).to.have.been.calledOnce
                  expect(error).to.have.been.calledOnce
                }
              })

              it('should execute error callback with `exit 1` command', async () => {
                try {
                  await promisify(childProcess[methodName])('node -e "process.exit(1)"')
                  return Promise.reject(new Error('Command expected to fail'))
                } catch (e) {
                  expect(start).to.have.been.calledOnceWith({ command: 'node -e "process.exit(1)"', shell: true })
                  expect(finish).to.have.been.calledOnceWith({
                    command: 'node -e "process.exit(1)"',
                    shell: true,
                    result: 1
                  })
                  expect(error).to.have.been.calledOnce
                }
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
                  shell: false,
                  result: result
                },
                'tracing:datadog:child_process:execution:start')

                expect(finish).to.have.been.calledOnceWith({
                  command: 'ls',
                  shell: false,
                  result: result
                },
                'tracing:datadog:child_process:execution:end')

                expect(error).not.to.have.been.called
              })

              it('should execute error callback', () => {
                let childError
                try {
                  childProcess[methodName]('invalid_command_test')
                } catch (error) {
                  childError = error
                } finally {
                  expect(start).to.have.been.calledOnceWith({
                    command: 'invalid_command_test',
                    shell: false,
                    error: childError
                  })
                  expect(finish).to.have.been.calledOnce
                  expect(error).to.have.been.calledOnce
                }
              })

              it('should execute error callback with `exit 1` command', () => {
                let childError
                try {
                  childProcess[methodName]('node -e "process.exit(1)"', { shell: true })
                } catch (error) {
                  childError = error
                } finally {
                  expect(start).to.have.been.calledOnceWith({
                    command: 'node -e "process.exit(1)"',
                    shell: true,
                    error: childError
                  })
                  expect(finish).to.have.been.calledOnce
                }
              })
            })
          })
        })

        describe('command interpreted by a shell by default', () => {
          execSyncShellMethods.forEach(methodName => {
            describe(`method ${methodName}`, () => {
              it('should execute success callbacks', () => {
                const result = childProcess[methodName]('ls')

                expect(start).to.have.been.calledOnceWith({
                  command: 'ls',
                  shell: true,
                  result
                })
                expect(finish).to.have.been.calledOnceWith({
                  command: 'ls',
                  shell: true,
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
                  expect(start).to.have.been.calledOnceWith({
                    command: 'invalid_command_test',
                    shell: true,
                    error: childError
                  })
                  expect(finish).to.have.been.calledOnce
                  expect(error).to.have.been.calledOnce
                }
              })

              it('should execute error callback with `exit 1` command', () => {
                let childError
                try {
                  childProcess[methodName]('node -e "process.exit(1)"')
                } catch (error) {
                  childError = error
                } finally {
                  expect(start).to.have.been.calledOnceWith({
                    command: 'node -e "process.exit(1)"',
                    shell: true,
                    error: childError
                  })
                  expect(finish).to.have.been.calledOnce
                }
              })
            })
          })
        })
      })
    })
  })
})
