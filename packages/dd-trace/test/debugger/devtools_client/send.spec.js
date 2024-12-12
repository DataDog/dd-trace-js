'use strict'

require('../../setup/mocha')

const { hostname: getHostname } = require('os')
const { expectWithin, getRequestOptions } = require('./utils')
const JSONQueue = require('../../../src/debugger/devtools_client/queue')
const { version } = require('../../../../../package.json')

process.env.DD_ENV = 'my-env'
process.env.DD_VERSION = 'my-version'
const service = 'my-service'
const commitSHA = 'my-commit-sha'
const repositoryUrl = 'my-repository-url'
const url = 'my-url'
const ddsource = 'dd_debugger'
const hostname = getHostname()
const message = { message: true }
const logger = { logger: true }
const dd = { dd: true }
const snapshot = { snapshot: true }

describe('input message http requests', function () {
  let send, request, queue

  beforeEach(function () {
    request = sinon.spy()
    request['@noCallThru'] = true

    class JSONQueueSpy extends JSONQueue {
      constructor (...args) {
        super(...args)
        queue = this
        sinon.spy(this, 'add')
      }
    }

    send = proxyquire('../src/debugger/devtools_client/send', {
      './config': { service, commitSHA, repositoryUrl, url, '@noCallThru': true },
      './queue': JSONQueueSpy,
      '../../exporters/common/request': request
    })
  })

  it('should queue instead of calling request directly', function () {
    const callback = sinon.spy()

    send(message, logger, dd, snapshot, callback)
    expect(request).to.not.have.been.called
    expect(queue.add).to.have.been.calledOnceWith(
      JSON.stringify(getPayload())
    )
    expect(callback).to.not.have.been.called
  })

  it('should call request with the expected payload once the queue is flushed', function (done) {
    const callback1 = sinon.spy()
    const callback2 = sinon.spy()
    const callback3 = sinon.spy()

    send({ message: 1 }, logger, dd, snapshot, callback1)
    send({ message: 2 }, logger, dd, snapshot, callback2)
    send({ message: 3 }, logger, dd, snapshot, callback3)
    expect(request).to.not.have.been.called

    expectWithin(1200, () => {
      expect(request).to.have.been.calledOnceWith(JSON.stringify([
        getPayload({ message: 1 }),
        getPayload({ message: 2 }),
        getPayload({ message: 3 })
      ]))

      const opts = getRequestOptions(request)
      expect(opts).to.have.property('method', 'POST')
      expect(opts).to.have.property(
        'path',
        '/debugger/v1/input?ddtags=' +
          `env%3A${process.env.DD_ENV}%2C` +
          `version%3A${process.env.DD_VERSION}%2C` +
          `debugger_version%3A${version}%2C` +
          `host_name%3A${hostname}%2C` +
          `git.commit.sha%3A${commitSHA}%2C` +
          `git.repository_url%3A${repositoryUrl}`
      )

      expect(callback1).to.not.have.been.calledOnce
      expect(callback2).to.not.have.been.calledOnce
      expect(callback3).to.not.have.been.calledOnce

      request.firstCall.callback()

      expect(callback1).to.have.been.calledOnce
      expect(callback2).to.have.been.calledOnce
      expect(callback3).to.have.been.calledOnce

      done()
    })
  })
})

function getPayload (_message = message) {
  return {
    ddsource,
    hostname,
    service,
    message: _message,
    logger,
    dd,
    'debugger.snapshot': snapshot
  }
}
