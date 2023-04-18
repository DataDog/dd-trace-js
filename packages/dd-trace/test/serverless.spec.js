'use strict'

const { maybeStartServerlessMiniAgent } = require('../src/serverless')
const childProcess = require('child_process')
const fs = require('fs')
const log = require('../src/log')

require('./setup/tap')

describe('Serverless', () => {
  const childProcessSpawnSpy = sinon.spy(childProcess, 'spawn')
  const existsSyncStub = sinon.stub(fs, 'existsSync').returns(true)
  afterEach(() => {
    childProcessSpawnSpy.resetHistory()
  })

  it('dont spawn mini agent if not in google cloud function', () => {
    // if K_SERVICE or FUNCTION_NAME env vars aren't set, then it's NOT a cloud function env.
    process.env.DD_MINI_AGENT_PATH = 'fake_path'

    maybeStartServerlessMiniAgent()

    expect(childProcessSpawnSpy).to.not.have.been.called
    delete process.env.DD_MINI_AGENT_PATH
  })

  it('dont spawn mini agent if no mini agent path', () => {
    process.env.K_SERVICE = 'test_function'

    maybeStartServerlessMiniAgent()

    expect(childProcessSpawnSpy).to.not.have.been.called
    delete process.env.K_SERVICE
  })

  it('dont spawn mini agent if mini agent path is invalid', () => {
    process.env.K_SERVICE = 'test_function'
    process.env.DD_MINI_AGENT_PATH = 'fake_path'

    const logErrorSpy = sinon.spy(log, 'error')

    existsSyncStub.returns(false)

    maybeStartServerlessMiniAgent()

    // trying to spawn with an invalid path will return a non-descriptive error, so we want to catch
    // invalid paths and log our own error.
    expect(logErrorSpy).to.have.been.calledOnceWith(
      'Serverless Mini Agent did not start. DD_MINI_AGENT_PATH points to a non-existent file.'
    )

    expect(childProcessSpawnSpy).to.not.have.been.called
    delete process.env.K_SERVICE
    existsSyncStub.returns(true)
  })

  it('spawn mini agent when FUNCTION_NAME env var is defined', () => {
    process.env.FUNCTION_NAME = 'test_function'
    process.env.DD_MINI_AGENT_PATH = 'fake_path'

    maybeStartServerlessMiniAgent()

    expect(childProcessSpawnSpy).to.have.been.calledOnce
    delete process.env.FUNCTION_NAME
    delete process.env.DD_MINI_AGENT_PATH
  })

  it('spawn mini agent when K_SERVICE env var is defined', () => {
    process.env.K_SERVICE = 'test_function'
    process.env.DD_MINI_AGENT_PATH = 'fake_path'

    maybeStartServerlessMiniAgent()

    expect(childProcessSpawnSpy).to.have.been.calledOnce
    delete process.env.K_SERVICE
    delete process.env.DD_MINI_AGENT_PATH
  })
})
