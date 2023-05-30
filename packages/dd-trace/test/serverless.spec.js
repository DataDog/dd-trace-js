'use strict'

const fs = require('fs')
const log = require('../src/log')
const Proxy = require('../src/proxy')
const childProcess = require('child_process')

require('./setup/tap')

describe('Serverless', () => {
  const spawnStub = sinon.stub(childProcess, 'spawn').returns(null)

  // so maybeStartServerlessMiniAgent thinks the default mini agent binary path exists
  const existsSyncStub = sinon.stub(fs, 'existsSync').returns(true)

  sinon.stub(process, 'platform').value('linux') // the mini agent will only spawn in linux + windows

  let env
  let proxy

  beforeEach(() => {
    env = process.env
    process.env = {}
    proxy = new Proxy()
  })

  afterEach(() => {
    process.env = env
    spawnStub.resetHistory()
  })

  it('should not spawn mini agent if not in google cloud function or azure function', () => {
    // do not set any GCP or Azure environment variables

    proxy.init()

    expect(spawnStub).to.not.have.been.called
  })

  it('should spawn mini agent when FUNCTION_NAME and GCP_PROJECT env vars are defined', () => {
    process.env.FUNCTION_NAME = 'test_function'
    process.env.GCP_PROJECT = 'test_project'

    proxy.init()

    expect(spawnStub).to.have.been.calledOnce
  })

  it('should spawn mini agent when K_SERVICE and FUNCTION_TARGET env vars are defined', () => {
    process.env.K_SERVICE = 'test_function'
    process.env.FUNCTION_TARGET = 'function_target'

    proxy.init()

    expect(spawnStub).to.have.been.calledOnce
  })

  it('should spawn mini agent when AzureWebJobsScriptRoot and FUNCTIONS_EXTENSION_VERSION env vars are defined', () => {
    process.env.AzureWebJobsScriptRoot = '/home/site/wwwroot'
    process.env.FUNCTIONS_EXTENSION_VERSION = '4'

    proxy.init()

    expect(spawnStub).to.have.been.calledOnce
  })

  it('should log error if mini agent binary path is invalid', () => {
    process.env.K_SERVICE = 'test_function'
    process.env.FUNCTION_TARGET = 'function_target'

    const logErrorSpy = sinon.spy(log, 'error')

    existsSyncStub.returns(false)

    proxy.init()

    // trying to spawn with an invalid path will return a non-descriptive error, so we want to catch
    // invalid paths and log our own error.
    expect(logErrorSpy).to.have.been.calledWith(
      'Serverless Mini Agent did not start. Could not find mini agent binary.'
    )
    existsSyncStub.returns(true)
  })
})
