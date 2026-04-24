'use strict'

const assert = require('node:assert/strict')
const { describe, before, after, it } = require('mocha')
const { useEnv } = require('../../../../../../integration-tests/helpers')
const { useLlmObs, assertLlmObsSpanEvent, MOCK_STRING } = require('../../util')
const { withVersions } = require('../../../setup/mocha')
const iastFilter = require('../../../../src/appsec/iast/taint-tracking/filter')

const isDdTrace = iastFilter.isDdTrace

describe('Plugin', () => {
  useEnv({
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '<not-a-real-key>',
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: 'true',
    _DD_LLMOBS_FLUSH_INTERVAL: '0',
  })

  before(async () => {
    iastFilter.isDdTrace = file => {
      if (file.includes('dd-trace-js/versions/')) {
        return false
      }
      return isDdTrace(file)
    }
  })

  after(() => {
    iastFilter.isDdTrace = isDdTrace
  })

  const { getEvents } = useLlmObs({ plugin: 'claude-agent-sdk' })

  let query

  withVersions('claude-agent-sdk', '@anthropic-ai/claude-agent-sdk', '0.2.98', version => {
    before(async function () {
      query = require(`../../../../../../versions/@anthropic-ai/claude-agent-sdk@${version}`)
        .get()
        .query
    })

    it('creates an LLM Obs session span', async function () {
      for await (const msg of query({
        prompt: 'Say hello',
        options: {
          maxTurns: 1,
          env: {
            ...process.env,
            ANTHROPIC_BASE_URL: 'http://127.0.0.1:9126/vcr/anthropic',
            CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: 'true',
          },
        },
      })) {
        if (msg.type === 'result') break
      }

      const { llmobsSpans, apmSpans } = await getEvents(2)
      console.log('got this many apm spans', apmSpans.length) // 2
      console.log('got this many llmobs spans', llmobsSpans.length) // 2
      console.log('llmobs spans names', llmobsSpans.map(s => ({
        name: s.name,
        id: s.span_id,
        parent: s.parent_id,
      })))
      // const sessionEvent = llmobsSpans.find(s => s.name === 'session') ?? llmobsSpans[0]
      // const sessionApmSpan = apmSpans.find(s => s.meta?.['resource.name'] === 'session') ?? apmSpans[0]

      // assert.ok(sessionEvent)
      // assert.ok(sessionApmSpan)

      // assertLlmObsSpanEvent(sessionEvent, {
      //   span: sessionApmSpan,
      //   spanKind: 'agent',
      //   name: 'session',
      //   inputValue: 'Say hello',
      //   outputValue: MOCK_STRING,
      //   tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
      // })
    })
  })
})
