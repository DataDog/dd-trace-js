'use strict'

const { expect } = require('chai')
const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')
const nock = require('nock')
const dc = require('dc-polyfill')

withVersions('openai', 'openai', version => {
  if (!semver.intersects(version, '>=4')) return

  let openai, start, finish, error, asyncFinish

  const channel = dc.tracingChannel('apm:openai:request')

  before(() => {
    return agent.load('openai')
  })

  after(() => {
    return agent.close({ ritmReset: false })
  })

  beforeEach(() => {
    start = sinon.stub()
    finish = sinon.stub()
    error = sinon.stub()
    asyncFinish = sinon.stub()

    channel.subscribe({
      start,
      end: finish,
      asyncEnd: asyncFinish,
      error
    })

    const module = require(`../../../versions/openai@${version}`).get()
    openai = new module.OpenAI({
      apiKey: 'sk-DATADOG-INSTRUMENTATION-SPECS'
    })
  })

  afterEach(() => {
    channel.unsubscribe({
      start,
      end: finish,
      asyncEnd: asyncFinish,
      error
    })

    nock.cleanAll()
  })

  it('should end the channel when _thenUnwrap is used', async () => {
    if (!semver.intersects(version, '>=4.59.0')) return
    nock('https://api.openai.com:443')
      .post('/v1/chat/completions')
      .reply(200, {
        id: 'chatcmpl-7GaWqyMTD9BLmkmy8SxyjUGX3KSRN',
        object: 'chat.completion',
        created: 1684188020,
        model: 'gpt-4o',
        usage: {
          prompt_tokens: 37,
          completion_tokens: 10,
          total_tokens: 47
        },
        choices: [{
          message: {
            role: 'assistant',
            content: 'I am doing well, how about you?'
          },
          finish_reason: 'stop',
          index: 0
        }]
      })

    await openai.beta.chat.completions.parse({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello, OpenAI!', name: 'hunter2' }],
      temperature: 0.5,
      stream: false
    })

    expect(asyncFinish).to.have.been.calledOnce
  })

  it('should end the channel when .withResponse() is used for chat.completions.create', async () => {
    nock('https://api.openai.com:443')
      .post('/v1/chat/completions')
      .reply(200, {
        id: 'chatcmpl-7GaWqyMTD9BLmkmy8SxyjUGX3KSRN',
        object: 'chat.completion',
        created: 1684188020,
        model: 'gpt-4o',
        usage: {
          prompt_tokens: 37,
          completion_tokens: 10,
          total_tokens: 47
        },
        choices: [{
          message: {
            role: 'assistant',
            content: 'I am doing well, how about you?'
          },
          finish_reason: 'stop',
          index: 0
        }]
      })

    const promise = openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello, OpenAI!', name: 'hunter2' }],
      temperature: 0.5,
      stream: false
    })

    expect(promise).to.have.property('withResponse').that.is.a('function')

    await promise.withResponse()

    expect(asyncFinish).to.have.been.calledOnce
  })
})
