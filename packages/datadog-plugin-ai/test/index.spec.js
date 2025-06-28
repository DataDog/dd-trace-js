'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { useEnv } = require('../../../integration-tests/helpers')

describe('Plugin', () => {
  before(() => agent.load('ai'))

  after(() => agent.close({ ritmReset: false }))

  useEnv({
    OPENAI_API_KEY: '<not-a-real-key>'
  })

  withVersions('ai', 'ai', version => {
    let ai // eslint-disable-line
    let openai // eslint-disable-line

    beforeEach(() => {
      ai = require(`../../../versions/ai@${version}`).get()

      const OpenAI = require('../../../versions/@ai-sdk/openai').get()
      openai = OpenAI.createOpenAI({
        baseURL: 'http://127.0.0.1:9126/snapshot-server/openai'
      })
    })

    it('creates a span for generateText', async () => {})

    it('creates a span for generateObject', async () => {})

    it('creates a span for embed', async () => {})

    it('creates a span for embedMany', async () => {})

    it('creates a span for streamText', async () => {})

    it('creates a span for streamObject', async () => {})

    it('creates a span for a tool call', async () => {})
  })
})
