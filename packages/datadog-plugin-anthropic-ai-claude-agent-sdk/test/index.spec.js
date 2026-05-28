'use strict'

const assert = require('node:assert/strict')

const sinon = require('sinon')

const { ANY_STRING } = require('../../../integration-tests/helpers')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const TestSetup = require('./test-setup')

const testSetup = new TestSetup()

describe('Plugin', () => {
  describe('anthropic-ai-claude-agent-sdk', () => {
    withVersions('anthropic-ai-claude-agent-sdk', '@anthropic-ai/claude-agent-sdk', version => {
      describe('without configuration', () => {
        let tracer

        before(async () => {
          tracer = await agent.load(['anthropic-ai-claude-agent-sdk'], [{}])
        })

        after(async () => {
          await agent.close()
        })

        before(async function () {
          this.timeout(30000)
          const mod = await import('@anthropic-ai/claude-agent-sdk') // eslint-disable-line n/no-missing-import
          await testSetup.setup(mod)
        })

        describe('query() - agent.execute', () => {
          it('should generate span with correct tags (happy path)', async () => {
            const traceAssertion = agent.assertFirstTraceSpan(
              {
                name: 'anthropic-ai-claude-agent-sdk.query',
                meta: {
                  'span.kind': 'client',
                  component: 'anthropic-ai-claude-agent-sdk',
                  'out.host': 'api.anthropic.com',
                },
              }
            )

            const result = await testSetup.query()
            assert.ok(result.isAsyncIterable, 'query() should return an async iterable')
            assert.ok(result.hasClose, 'query() result should expose close()')
            assert.strictEqual(result.messages.length, 3, 'should iterate through the full message sequence')
            assert.strictEqual(result.messages.at(-1).type, 'result')

            return traceAssertion
          })

          it('should generate span with error tags (error path)', async () => {
            const traceAssertion = agent.assertFirstTraceSpan(
              {
                name: 'anthropic-ai-claude-agent-sdk.query',
                meta: {
                  'span.kind': 'client',
                  component: 'anthropic-ai-claude-agent-sdk',
                  'out.host': 'api.anthropic.com',
                  'error.type': ANY_STRING,
                  'error.message': ANY_STRING,
                  'error.stack': ANY_STRING,
                },
                error: 1,
              }
            )

            let caught
            try {
              await testSetup.queryError()
            } catch (err) {
              caught = err
            }
            assert.ok(caught, 'queryError() should throw')
            assert.strictEqual(caught.name, 'TypeError')

            return traceAssertion
          })
        })

        describe('peer service', () => {
          let computeStub

          beforeEach(() => {
            const plugin = tracer._pluginManager._pluginsByName['anthropic-ai-claude-agent-sdk']
            computeStub = sinon.stub(plugin._tracerConfig, 'spanComputePeerService').value(true)
          })

          afterEach(() => {
            computeStub.restore()
          })

          it('should compute peer.service from out.host precursor on the query span', async () => {
            const traceAssertion = agent.assertFirstTraceSpan(
              {
                name: 'anthropic-ai-claude-agent-sdk.query',
                meta: {
                  'span.kind': 'client',
                  component: 'anthropic-ai-claude-agent-sdk',
                  'out.host': 'api.anthropic.com',
                  'peer.service': 'api.anthropic.com',
                  '_dd.peer.service.source': 'out.host',
                },
              }
            )

            await testSetup.query()

            return traceAssertion
          })
        })
      })
    })
  })
})
