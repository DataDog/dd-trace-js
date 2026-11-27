'use strict'

const assert = require('node:assert/strict')
const { after, before, describe, it } = require('mocha')
const { ANY_STRING } = require('../../../integration-tests/helpers')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const TestSetup = require('./test-setup')

describe('Plugin', () => {
  describe('dataloader', () => {
    withVersions('dataloader', 'dataloader', version => {
      const testSetup = new TestSetup()
      let loadResource
      let loadErrorResource
      let loadManyResource
      let loadManyErrorResource

      describe(`with dataloader (${version})`, () => {
        before(async () => {
          await agent.load('dataloader')
          const nodePath = process.env.NODE_PATH
          delete process.env.NODE_PATH
          require('module').Module._initPaths()
          const versionedModule = require(`../../../versions/dataloader@${version}/node_modules/dataloader`)
          process.env.NODE_PATH = nodePath
          require('module').Module._initPaths()
          await testSetup.setup(versionedModule)
          loadResource = testSetup.loader.name || 'dataloader.load'
          loadErrorResource = testSetup.rejectingLoader.name || 'dataloader.load'
          loadManyResource = testSetup.loader.name || 'dataloader.loadMany'
          loadManyErrorResource = testSetup.rejectingLoader.name || 'dataloader.loadMany'
        })

        after(async () => {
          await testSetup.teardown()
          await agent.close()
        })

        describe('DataLoader.load() - dataloader.load', () => {
          it('should generate span with correct tags (happy path)', async () => {
            const traceAssertion = agent.assertFirstTraceSpan({
              name: 'dataloader.load',
              resource: loadResource,
              meta: {
                'span.kind': 'internal',
                component: 'dataloader',
              },
              metrics: {},
            })

            // Execute operation via test setup
            await testSetup.dataLoaderLoad()

            return traceAssertion
          })

          it('should generate span with error tags (error path)', async () => {
            const traceAssertion = agent.assertFirstTraceSpan(
              {
                name: 'dataloader.load',
                resource: loadErrorResource,
                meta: {
                  'span.kind': 'internal',
                  'error.type': 'Error',
                  'error.message': 'batch failed',
                  'error.stack': ANY_STRING,
                  component: 'dataloader',
                },
                metrics: {},
                error: 1,
              }
            )

            // Execute operation error variant
            try {
              await testSetup.dataLoaderLoadError()
            } catch {
              // Expected error
            }

            return traceAssertion
          })
        })

        describe('DataLoader.loadMany() - dataloader.loadMany', () => {
          it('should generate span with correct tags (happy path)', async () => {
            const traceAssertion = agent.assertSomeTraces(traces => {
              const spans = traces.flat()
              assert.strictEqual(spans.length, 1)
              assert.strictEqual(spans[0].name, 'dataloader.loadMany')
              assert.strictEqual(spans[0].resource, loadManyResource)
              assert.strictEqual(spans[0].meta['span.kind'], 'internal')
              assert.strictEqual(spans[0].meta.component, 'dataloader')
            })

            // Execute operation via test setup
            await testSetup.dataLoaderLoadMany()
            /** @type {{ span?: { context: () => { _name?: string } } } | undefined} */
            const batchStore = testSetup.batchStore
            assert.strictEqual(batchStore?.span?.context()._name, 'dataloader.loadMany')

            return traceAssertion
          })

          it('should preserve per-item errors without marking the span failed', async () => {
            const traceAssertion = agent.assertFirstTraceSpan(
              {
                name: 'dataloader.loadMany',
                resource: loadManyErrorResource,
                meta: {
                  'span.kind': 'internal',
                  component: 'dataloader',
                },
                metrics: {},
              }
            )

            const [result] = await testSetup.dataLoaderLoadManyError()
            assert.ok(result instanceof Error)
            assert.strictEqual(result.message, 'batch failed')

            return traceAssertion
          })

          it('should generate span with validation error tags', async () => {
            const traceAssertion = agent.assertFirstTraceSpan(
              {
                name: 'dataloader.loadMany',
                resource: loadManyResource,
                meta: {
                  'span.kind': 'internal',
                  'error.type': 'TypeError',
                  'error.message': 'The loader.loadMany() function must be called with Array<key> but got: null.',
                  'error.stack': ANY_STRING,
                  component: 'dataloader',
                },
                metrics: {},
                error: 1,
              }
            )

            // Execute operation validation variant
            try {
              await testSetup.dataLoaderLoadManyValidationError()
            } catch {
              // Expected error
            }

            return traceAssertion
          })
        })
      })
    })
  })
})
