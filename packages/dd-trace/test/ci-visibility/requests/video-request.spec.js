'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const { PassThrough, Readable } = require('node:stream')

const { afterEach, describe, it } = require('mocha')
const nock = require('nock')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')

describe('ci-visibility/requests/video-request', () => {
  afterEach(() => {
    nock.cleanAll()
  })

  function getOptions (extra = {}) {
    return {
      method: 'POST',
      headers: {
        'Content-Length': 13,
        'Content-Type': 'video/webm',
      },
      path: '/upload',
      timeout: 1000,
      url: new URL('http://localhost:8126'),
      ...extra,
    }
  }

  it('streams one video request attempt', done => {
    const intake = nock('http://localhost:8126')
      .post('/upload', 'video-content')
      .reply(200, 'ok')
    const requestVideo = require('../../../src/ci-visibility/requests/video-request')

    requestVideo(Readable.from('video-content'), getOptions(), (error, result, statusCode) => {
      assert.ifError(error)
      assert.strictEqual(result, 'ok')
      assert.strictEqual(statusCode, 200)
      assert.ok(intake.isDone())
      done()
    })
  })

  it('returns the response status and headers on an intake error', done => {
    nock('http://localhost:8126')
      .post('/upload', 'video-content')
      .reply(503, 'unavailable', { 'retry-after': '1' })
    const requestVideo = require('../../../src/ci-visibility/requests/video-request')

    requestVideo(Readable.from('video-content'), getOptions(), (error, result, statusCode, headers) => {
      assert.strictEqual(error.status, 503)
      assert.strictEqual(result, null)
      assert.strictEqual(statusCode, 503)
      assert.strictEqual(headers['retry-after'], '1')
      done()
    })
  })

  it('aborts the active stream and request', done => {
    const body = new Readable({ read () {} })
    const controller = new AbortController()
    const requestVideo = require('../../../src/ci-visibility/requests/video-request')
    nock('http://localhost:8126').post('/upload').reply(200, 'ok')

    requestVideo(body, getOptions({ signal: controller.signal }), error => {
      assert.strictEqual(error.name, 'AbortError')
      assert.strictEqual(body.destroyed, true)
      done()
    })
    controller.abort()
  })

  it('destroys an aborted request after its body finishes', done => {
    const controller = new AbortController()
    const req = new PassThrough()
    req.setTimeout = sinon.stub()
    const requestVideo = proxyquire('../../../src/ci-visibility/requests/video-request', {
      'node:http': {
        ...http,
        request: () => req,
      },
    })

    req.once('finish', () => controller.abort())
    requestVideo(Readable.from('video-content'), getOptions({ signal: controller.signal }), error => {
      assert.strictEqual(error.name, 'AbortError')
      assert.strictEqual(req.writableFinished, true)
      assert.strictEqual(req.destroyed, true)
      done()
    })
  })

  it('marks a body read error as non-retriable', done => {
    const readError = Object.assign(new Error('video disappeared'), { code: 'ENOENT' })
    const body = new Readable({
      read () {
        this.destroy(readError)
      },
    })
    const requestVideo = require('../../../src/ci-visibility/requests/video-request')
    nock('http://localhost:8126').post('/upload').reply(200, 'ok')

    requestVideo(body, getOptions(), error => {
      assert.strictEqual(error, readError)
      assert.strictEqual(error.retryable, false)
      done()
    })
  })

  it('reports a synchronous request setup error without leaking capacity', () => {
    const requestError = new Error('invalid request options')
    const requestVideo = proxyquire('../../../src/ci-visibility/requests/video-request', {
      'node:http': {
        ...http,
        request: () => { throw requestError },
      },
    })
    const body = Readable.from('video-content')
    const callback = sinon.spy()

    requestVideo(body, getOptions(), callback)

    sinon.assert.calledOnceWithExactly(callback, requestError)
    assert.strictEqual(body.destroyed, true)
    assert.strictEqual(requestVideo.writable, true)
  })

  it('does not send an API key over cleartext to a non-loopback host', () => {
    let requestOptions
    const req = new PassThrough()
    req.setTimeout = sinon.stub()
    const requestVideo = proxyquire('../../../src/ci-visibility/requests/video-request', {
      'node:http': {
        ...http,
        request: options => {
          requestOptions = options
          return req
        },
      },
    })

    requestVideo(Readable.from('video-content'), getOptions({
      headers: {
        'Content-Length': 13,
        'DD-API-KEY': 'secret',
      },
      url: new URL('http://example.com'),
    }), sinon.spy())

    assert.strictEqual(requestOptions.headers['DD-API-KEY'], undefined)
    req.emit('error', new Error('stop'))
  })

  it('limits active video requests independently', () => {
    const requests = []
    const requestVideo = proxyquire('../../../src/ci-visibility/requests/video-request', {
      'node:http': {
        ...http,
        request: (options, onResponse) => {
          const req = new PassThrough()
          req.setTimeout = sinon.stub()
          requests.push({ onResponse, options, req })
          return req
        },
      },
    })

    for (let index = 0; index < 16; index++) {
      requestVideo(Readable.from('video-content'), getOptions(), sinon.spy())
    }
    assert.strictEqual(requestVideo.writable, false)

    const rejectedBody = Readable.from('video-content')
    const rejectedCallback = sinon.spy()
    requestVideo(rejectedBody, getOptions(), rejectedCallback)

    assert.strictEqual(requests.length, 16)
    assert.strictEqual(rejectedBody.destroyed, true)
    sinon.assert.calledOnce(rejectedCallback)
    assert.strictEqual(rejectedCallback.firstCall.args[0].code, 'ERR_DD_VIDEO_REQUEST_LIMIT')

    requests[0].req.emit('error', new Error('stop'))
    assert.strictEqual(requestVideo.writable, true)
    for (let index = 1; index < requests.length; index++) {
      requests[index].req.emit('error', new Error('stop'))
    }
  })
})
