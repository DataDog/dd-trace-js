'use strict'
const { channel } = require('../src/helpers/instrument')
const agent = require('../../dd-trace/test/plugins/agent')
describe('child process', () => {
  const modules = ['child_process', 'node:child_process']
  const execAsyncMethods = ['exec', 'execFile', 'spawn']
  const execSyncMethods = ['execFileSync', 'execSync', 'spawnSync']

  const childProcessChannelStart = channel('datadog:child_process:execution:start')
  const childProcessChannelFinish = channel('datadog:child_process:execution:finish')
  const childProcessChannelError = channel('datadog:child_process:execution:error')

  modules.forEach((childProcessModuleName) => {
    describe(childProcessModuleName, () => {
      let start, finish, error, childProcess

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
        childProcessChannelStart.subscribe(start)
        childProcessChannelFinish.subscribe(finish)
        childProcessChannelError.subscribe(error)

        childProcess = require(childProcessModuleName)
      })

      afterEach(() => {
        childProcessChannelStart.unsubscribe(start)
        childProcessChannelFinish.unsubscribe(finish)
        childProcessChannelError.unsubscribe(error)
      })

      describe('async methods', (done) => {
        execAsyncMethods.forEach((methodName) => {
          describe(`method ${methodName}`, () => {
            it('should execute success callbacks', (done) => {
              const res = childProcess[methodName]('ls')
              res.on('close', () => {
                expect(start).to.have.been.calledOnceWith({ command: 'ls' })
                expect(finish).to.have.been.calledOnceWith({ exitCode: 0 })
                expect(error).not.to.have.been.called
                done()
              })
            })

            it('should execute error callback', (done) => {
              const res = childProcess[methodName]('invalid_command_test')
              res.on('close', () => {
                expect(start).to.have.been.calledOnceWith({ command: 'invalid_command_test' })
                expect(finish).to.have.been.calledOnce
                expect(error).to.have.been.calledOnce
                done()
              })
            })
          })
        })
      })

      describe('sync methods', (done) => {
        execSyncMethods.forEach((methodName) => {
          describe(`method ${methodName}`, () => {
            it('should execute success callbacks', () => {
              childProcess[methodName]('ls')
              expect(start).to.have.been.calledOnceWith({ command: 'ls' })
              expect(finish).to.have.been.calledOnceWith({ exitCode: 0 })
              expect(error).not.to.have.been.called
            })

            it('should execute error callback', () => {
              try {
                childProcess[methodName]('invalid_command_test')
              } catch (e) {
                expect(start).to.have.been.calledOnceWith({ command: 'invalid_command_test' })
                expect(finish).to.have.been.calledOnce
                expect(error).to.have.been.calledOnce
              }
            })
          })
        })
      })
    })
  })
})
