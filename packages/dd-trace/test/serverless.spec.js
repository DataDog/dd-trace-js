'use strict'

const fs = require('fs')
const log = require('../src/log')
const Proxy = require('../src/proxy')
const childProcess = require('child_process')

require('./setup/tap')

describe('Serverless', () => {
  const spawnSpy = sinon.spy(childProcess, 'spawn')
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
    existsSyncStub.returns(true)
  })

  it('should not spawn mini agent if not in google cloud function', () => {
    // if (K_SERVICE && FUNCTION_TARGET) env vars are set, we are in a GCP function with a newer runtime
    // if (FUNCTION_NAME && GCP_PROJECT) env vars are set, we are in a GCP function with a deprecated runtime
    process.env.DD_MINI_AGENT_PATH = 'fake_path'

    proxy.init()

    expect(spawnSpy).to.not.have.been.called
    delete process.env.DD_MINI_AGENT_PATH
  })

  it('should spawn mini agent when FUNCTION_NAME and GCP_PROJECT env vars are defined', () => {
    process.env.FUNCTION_NAME = 'test_function'
    process.env.GCP_PROJECT = 'test_project'
    process.env.DD_MINI_AGENT_PATH = 'fake_path'

    proxy.init()

    expect(spawnSpy).to.have.been.calledOnce
  })

  it('should spawn mini agent when K_SERVICE and FUNCTION_TARGET env vars are defined', () => {
    process.env.K_SERVICE = 'test_function'
    process.env.FUNCTION_TARGET = 'function_target'
    process.env.DD_MINI_AGENT_PATH = 'fake_path'

    proxy.init()

    expect(spawnSpy).to.have.been.calledOnce
  })

  it('should log error if mini agent binary path is invalid', () => {
    process.env.K_SERVICE = 'test_function'
    process.env.FUNCTION_TARGET = 'function_target'
    process.env.DD_MINI_AGENT_PATH = 'fake_path'

    const logErrorSpy = sinon.spy(log, 'error')

    existsSyncStub.returns(false)

    proxy.init()

    // trying to spawn with an invalid path will return a non-descriptive error, so we want to catch
    // invalid paths and log our own error.
    expect(logErrorSpy).to.have.been.calledOnceWith(
      'Serverless Mini Agent did not start. Could not find mini agent binary.'
    )
  })
})
