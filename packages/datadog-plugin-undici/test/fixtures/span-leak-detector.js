'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const http = require('node:http')

const { channel } = require('dc-polyfill')
const { after, before, describe, it } = require('mocha')

const agent = require('../../../dd-trace/test/plugins/agent')

describe('Undici span leak detector process fixture', () => {
  const finishCh = channel('dd-trace:span:finish')
  let dispatcher
  let finishedSpan
  let request
  let server
  let tracer

  /**
   * @param {import('node:http').IncomingMessage} _request
   * @param {import('node:http').ServerResponse} response
   */
  function handleRequest (_request, response) {
    response.end('ok')
  }

  /** @param {import('../../../dd-trace/src/opentracing/span')} span */
  function observeFinishedSpan (span) {
    if (span._integrationName === 'undici') {
      finishedSpan = span
    }
  }

  before(async () => {
    finishCh.subscribe(observeFinishedSpan)
    tracer = await agent.load('undici')
    const undici = require('../../../../versions/undici@6').get()
    dispatcher = new undici.Agent()
    request = undici.request
    server = http.createServer(handleRequest)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
  })

  after(async () => {
    finishCh.unsubscribe(observeFinishedSpan)
    const serverClosed = once(server, 'close')
    server.close()
    await Promise.all([serverClosed, dispatcher.close(), agent.close()])
  })

  it('finishes a request span', async () => {
    const address = /** @type {import('node:net').AddressInfo} */ (server.address())
    const response = await request(`http://127.0.0.1:${address.port}`, { dispatcher })
    await response.body.text()

    assert.strictEqual(finishedSpan._integrationName, 'undici')
    if (process.env.DD_TEST_RETAIN_FINISHED_SPAN === '1') {
      tracer.scope().activate(finishedSpan, () => setInterval(() => {}, 60_000).unref())
    }
    finishedSpan = undefined
  })
})
