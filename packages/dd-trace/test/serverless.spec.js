'use strict'

const fs = require('fs')
const log = require('../src/log')
const Proxy = require('../src/proxy')
const childProcess = require('child_process')

require('./setup/tap')

describe('Serverless', () => {
  const spawnSpy = sinon.spy(childProcess, 'spawn')

  // so maybeStartServerlessMiniAgent thinks the default mini agent binary path exists
  const existsSyncStub = sinon.stub(fs, 'existsSync').returns(true)

  let env
  let proxy

  beforeEach(() => {
    env = process.env
    process.env = {}
    proxy = new Proxy()
  })

  afterEach(() => {
    process.env = env
    spawnSpy.resetHistory()
  })

  it('should not spawn mini agent if not in google cloud function', () => {
    // do not set any GCP environment variables

    proxy.init()

    expect(spawnSpy).to.not.have.been.called
    delete process.env.DD_MINI_AGENT_PATH
  })

  it('should spawn mini agent when FUNCTION_NAME and GCP_PROJECT env vars are defined', () => {
    process.env.FUNCTION_NAME = 'test_function'
    process.env.GCP_PROJECT = 'test_project'

    proxy.init()

    expect(spawnSpy).to.have.been.calledOnce
  })

  it('should spawn mini agent when K_SERVICE and FUNCTION_TARGET env vars are defined', () => {
    process.env.K_SERVICE = 'test_function'
    process.env.FUNCTION_TARGET = 'function_target'

    proxy.init()

    expect(spawnSpy).to.have.been.calledOnce
  })

  it('should log error if mini agent binary path is invalid', () => {
    process.env.K_SERVICE = 'test_function'
    process.env.FUNCTION_TARGET = 'function_target'

    const logErrorSpy = sinon.spy(log, 'error')

    existsSyncStub.returns(false)

    proxy.init()

    // trying to spawn with an invalid path will return a non-descriptive error, so we want to catch
    // invalid paths and log our own error.
    expect(logErrorSpy).to.have.been.calledOnceWith(
      'Serverless Mini Agent did not start. Could not find mini agent binary.'
    )
    existsSyncStub.returns(true)
  })
})
