'use strict'

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { inspect } = require('node:util')

const { channel } = require('dc-polyfill')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const LLMObsSpanProcessor = require('../../../src/llmobs/span_processor')
const LLMObsTagger = require('../../../src/llmobs/tagger')
const LLMObsEvalMetricsWriter = require('../../../src/llmobs/writers/evaluations')
const LLMObsSpanWriter = require('../../../src/llmobs/writers/spans')
const agent = require('../../plugins/agent')
const { getConfigFresh } = require('../../helpers/config')
const tracerVersion = require('../../../../../package.json').version
const { removeDestroyHandler } = require('../util')
const { assertObjectContains } = require('../../../../../integration-tests/helpers')
const { WarmCache, cacheKey } = require('../../../src/llmobs/prompts/cache')
const ManagedPrompt = require('../../../src/llmobs/prompts/prompt')

const injectCh = channel('dd-trace:span:inject')

describe('sdk', () => {
  let LLMObsSDK
  let llmobs
  let llmobsModule
  let tracer
  let clock

  before(async () => {
    tracer = await agent.load(null, [], {
      service: 'service',
      llmobs: { mlApp: 'mlApp', agentlessEnabled: false },
    })
    llmobs = tracer.llmobs

    llmobsModule = require('../../../../dd-trace/src/llmobs')

    // spy on properties
    sinon.spy(LLMObsSpanProcessor.prototype, 'process')
    sinon.spy(LLMObsSpanProcessor.prototype, 'format')
    sinon.spy(tracer._tracer._processor, 'process')

    // stub writer functionality
    sinon.stub(LLMObsEvalMetricsWriter.prototype, 'append')
    sinon.stub(LLMObsEvalMetricsWriter.prototype, 'flush')
    sinon.stub(LLMObsSpanWriter.prototype, 'append')
    sinon.stub(LLMObsSpanWriter.prototype, 'flush')

    LLMObsSDK = require('../../../src/llmobs/sdk')

    // remove max listener warnings, we don't care about the writer anyways
    removeDestroyHandler()

    clock = sinon.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })
  })

  afterEach(() => {
    LLMObsSpanProcessor.prototype.process.resetHistory()
    LLMObsSpanProcessor.prototype.format.resetHistory()
    tracer._tracer._processor.process.resetHistory()

    LLMObsEvalMetricsWriter.prototype.append.resetHistory()
    LLMObsEvalMetricsWriter.prototype.flush.resetHistory()

    LLMObsSpanWriter.prototype.append.resetHistory()
    LLMObsSpanWriter.prototype.flush.resetHistory()

    removeDestroyHandler()
  })

  after(async () => {
    sinon.restore()
    llmobsModule.disable()
    await agent.close()
  })

  describe('enabled', () => {
    for (const [value, label] of [
      [true, 'enabled'],
      [false, 'disabled'],
    ]) {
      it(`returns ${value} when llmobs is ${label}`, () => {
        const enabledOrDisabledLLMObs = new LLMObsSDK(null, { disable () {} }, { llmobs: { DD_LLMOBS_ENABLED: value } })

        assert.strictEqual(enabledOrDisabledLLMObs.enabled, value)
        enabledOrDisabledLLMObs.disable() // unsubscribe
      })
    }
  })

  describe('experiments', () => {
    it('exposes dataset operations only through the experiments facade', () => {
      assert.strictEqual(typeof llmobs.experiments.createDataset, 'function')
      assert.strictEqual(typeof llmobs.experiments.pullDataset, 'function')
    })
  })

  describe('prompts', () => {
    it('works through the configured SDK while LLMObs span export is disabled', async () => {
      const config = getConfigFresh({})
      config.DD_API_KEY = 'api-key'
      config.env = 'production'
      const provider = {
        resolveObjectEvaluation: sinon.stub().resolves({
          value: { prompt_id: 'greeting', version: 1, template: 'Hello' },
        }),
      }
      const providerGetter = sinon.stub().returns(provider)
      const disabledLLMObs = new LLMObsSDK(tracer._tracer, { disable () {} }, config, providerGetter)

      sinon.assert.notCalled(providerGetter)

      const prompt = await disabledLLMObs.getPrompt('greeting')

      assert.strictEqual(disabledLLMObs.enabled, false)
      assert.strictEqual(prompt.source, 'ff')
      sinon.assert.calledOnce(providerGetter)
      sinon.assert.calledOnce(provider.resolveObjectEvaluation)
    })

    it('clears the warm cache before the lazy manager is created', () => {
      const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-sdk-prompts-'))
      const config = getConfigFresh({})
      config.DD_API_KEY = 'api-key'
      config.DD_LLMOBS_PROMPTS_CACHE_DIR = cacheDir
      config.DD_LLMOBS_PROMPTS_CACHE_TTL = 60
      const cache = new WarmCache({
        cacheDir,
        ttlMs: 60_000,
        origin: 'https://api.datadoghq.com',
        apiKey: config.DD_API_KEY,
      })
      cache.set(cacheKey('greeting', ['latest']), new ManagedPrompt({
        id: 'greeting', version: '1', source: 'cache', template: 'Hello',
      }))
      const disabledLLMObs = new LLMObsSDK(tracer._tracer, { disable () {} }, config)

      disabledLLMObs.clearPromptCache({ hot: false })

      assert.deepStrictEqual(fs.readdirSync(cacheDir), [])
      fs.rmSync(cacheDir, { recursive: true, force: true })
    })
  })

  describe('enable', () => {
    it('enables llmobs if it is disabled', () => {
      const config = getConfigFresh({})
      const llmobsModule = {
        enable: sinon.stub(),
        disable () {},
      }

      // do not fully enable a disabled llmobs
      const disabledLLMObs = new LLMObsSDK(tracer._tracer, llmobsModule, config)

      disabledLLMObs.enable({
        mlApp: 'mlApp',
      })

      assert.strictEqual(disabledLLMObs.enabled, true)
      assert.strictEqual(disabledLLMObs._config.llmobs.mlApp, 'mlApp')
      assert.strictEqual(disabledLLMObs._config.llmobs.agentlessEnabled, undefined)

      sinon.assert.called(llmobsModule.enable)

      disabledLLMObs.disable() // unsubscribe
    })

    it('recreates experiments after enabling llmobs', () => {
      const config = getConfigFresh({})
      config.DD_API_KEY = 'api-key'
      config.DD_APP_KEY = 'app-key'
      config.service = 'service'
      const llmobsModule = {
        enable: sinon.stub(),
        disable () {},
      }

      const disabledLLMObs = new LLMObsSDK(tracer._tracer, llmobsModule, config)

      assert.strictEqual(disabledLLMObs.experiments.createDataset('d').name(), 'd')

      disabledLLMObs.enable({
        mlApp: 'mlApp',
      })

      assert.strictEqual(typeof disabledLLMObs.experiments.createDataset('d').addRecord, 'function')

      disabledLLMObs.disable() // unsubscribe
    })

    it('does not enable llmobs if it is already enabled', () => {
      sinon.spy(llmobs._llmobsModule, 'enable')
      llmobs.enable({})

      assert.strictEqual(llmobs.enabled, true)
      sinon.assert.notCalled(llmobs._llmobsModule.enable)
      llmobs._llmobsModule.enable.restore()
    })

    it('does not enable llmobs if env var conflicts', () => {
      const config = getConfigFresh({})
      const llmobsModule = {
        enable: sinon.stub(),
      }

      // do not fully enable a disabled llmobs
      const disabledLLMObs = new LLMObsSDK(tracer._tracer, llmobsModule, config)
      process.env.DD_LLMOBS_ENABLED = 'false'

      disabledLLMObs.enable({})

      assert.strictEqual(disabledLLMObs.enabled, false)
      delete process.env.DD_LLMOBS_ENABLED
      disabledLLMObs.disable() // unsubscribe
    })
  })

  describe('disable', () => {
    it('disables llmobs if it is enabled', () => {
      const llmobsModule = {
        disable: sinon.stub(),
      }

      const config = getConfigFresh({
        llmobs: {
          agentlessEnabled: false,
        },
      })

      const enabledLLMObs = new LLMObsSDK(tracer._tracer, llmobsModule, config)

      assert.strictEqual(enabledLLMObs.enabled, true)
      enabledLLMObs.disable()

      assert.strictEqual(enabledLLMObs.enabled, false)
      sinon.assert.called(llmobsModule.disable)
    })

    it('recreates experiments after disabling llmobs', () => {
      const llmobsModule = {
        disable: sinon.stub(),
      }

      const config = getConfigFresh({
        llmobs: {
          agentlessEnabled: false,
          mlApp: 'mlApp',
        },
      })
      config.DD_API_KEY = 'api-key'
      config.DD_APP_KEY = 'app-key'
      config.service = 'service'

      const enabledLLMObs = new LLMObsSDK(tracer._tracer, llmobsModule, config)

      assert.strictEqual(typeof enabledLLMObs.experiments.createDataset('d').addRecord, 'function')

      enabledLLMObs.disable()

      assert.strictEqual(enabledLLMObs.experiments.createDataset('d').name(), 'd')
      sinon.assert.called(llmobsModule.disable)
    })

    it('does not disable llmobs if it is already disabled', () => {
      // do not fully enable a disabled llmobs
      const disabledLLMObs = new LLMObsSDK(null, { disable () {} }, { llmobs: { DD_LLMOBS_ENABLED: false } })
      sinon.spy(disabledLLMObs._llmobsModule, 'disable')

      disabledLLMObs.disable()

      assert.strictEqual(disabledLLMObs.enabled, false)
      sinon.assert.notCalled(disabledLLMObs._llmobsModule.disable)
    })
  })

  describe('tracing', () => {
    describe('trace', () => {
      describe('tracing behavior', () => {
        it('starts a span if llmobs is disabled but does not process it in the LLMObs span processor', () => {
          tracer._tracer._config.llmobs.DD_LLMOBS_ENABLED = false

          llmobs.trace({ kind: 'workflow', name: 'myWorkflow' }, (span, cb) => {
            const tag = LLMObsTagger.tagMap.get(span)
            assert.ok(tag == null, `Expected no LLMObs tag for span, got ${inspect(tag)}`)
            span.setTag('k', 'v')
            cb()
          })

          sinon.assert.called(llmobs._tracer._processor.process)
          sinon.assert.notCalled(LLMObsSpanProcessor.prototype.format)

          tracer._tracer._config.llmobs.DD_LLMOBS_ENABLED = true
        })

        it('throws if the kind is invalid', () => {
          assert.throws(() => llmobs.trace({ kind: 'invalid' }, () => {}))

          sinon.assert.notCalled(llmobs._tracer._processor.process)
          sinon.assert.notCalled(LLMObsSpanProcessor.prototype.format)
        })

        // TODO: need span kind optional for this
        it.skip('throws if no name is provided', () => {
          assert.throws(() => llmobs.trace({ kind: 'workflow' }, () => {}))

          sinon.assert.notCalled(llmobs._tracer._processor.process)
          sinon.assert.notCalled(LLMObsSpanProcessor.prototype.format)
        })

        it('traces a block', () => {
          let span

          llmobs.trace({ kind: 'workflow' }, _span => {
            span = _span
            sinon.spy(span, 'finish')
          })

          sinon.assert.called(span.finish)
        })

        it('traces a block with a callback', () => {
          let span
          let done

          llmobs.trace({ kind: 'workflow' }, (_span, _done) => {
            span = _span
            sinon.spy(span, 'finish')
            done = _done
          })

          sinon.assert.notCalled(span.finish)

          done()

          sinon.assert.called(span.finish)
        })

        it('traces a promise', done => {
          const deferred = {}
          const promise = new Promise(resolve => {
            deferred.resolve = resolve
          })

          let span

          llmobs
            .trace({ kind: 'workflow' }, _span => {
              span = _span
              sinon.spy(span, 'finish')
              return promise
            })
            .then(() => {
              sinon.assert.called(span.finish)
              done()
            })
            .catch(done)

          sinon.assert.notCalled(span.finish)

          deferred.resolve()
        })
      })

      describe('parentage', () => {
        it('starts a span with a distinct trace id', () => {
          llmobs.trace({ kind: 'workflow', name: 'test' }, span => {
            const traceId = LLMObsTagger.tagMap.get(span)['_ml_obs.trace_id']
            assert.ok(traceId)
            assert.notStrictEqual(traceId, span.context().toTraceId(true))
          })
        })

        it('sets span parentage correctly', () => {
          llmobs.trace({ kind: 'workflow', name: 'test' }, outerLLMSpan => {
            llmobs.trace({ kind: 'task', name: 'test' }, innerLLMSpan => {
              assert.strictEqual(
                LLMObsTagger.tagMap.get(innerLLMSpan)['_ml_obs.llmobs_parent_id'],
                outerLLMSpan.context().toSpanId()
              )

              assert.equal(
                LLMObsTagger.tagMap.get(innerLLMSpan)['_ml_obs.trace_id'],
                LLMObsTagger.tagMap.get(outerLLMSpan)['_ml_obs.trace_id']
              )
            })
          })
        })

        it('maintains llmobs parentage separately from apm spans', () => {
          llmobs.trace({ kind: 'workflow', name: 'outer-llm' }, outerLLMSpan => {
            assert.strictEqual(llmobs._active(), outerLLMSpan)
            tracer.trace('apmSpan', apmSpan => {
              assert.strictEqual(llmobs._active(), outerLLMSpan)
              llmobs.trace({ kind: 'workflow', name: 'inner-llm' }, innerLLMSpan => {
                assert.strictEqual(llmobs._active(), innerLLMSpan)

                // llmobs span linkage
                assert.strictEqual(
                  LLMObsTagger.tagMap.get(innerLLMSpan)['_ml_obs.llmobs_parent_id'],
                  outerLLMSpan.context().toSpanId()
                )

                // apm span linkage
                assert.strictEqual(innerLLMSpan.context()._parentId.toString(10), apmSpan.context().toSpanId())
                assert.strictEqual(apmSpan.context()._parentId.toString(10), outerLLMSpan.context().toSpanId())
              })
            })
          })
        })

        it('starts different traces for llmobs spans as child spans of an apm root span', () => {
          let apmTraceId, traceId1, traceId2
          tracer.trace('apmRootSpan', apmRootSpan => {
            apmTraceId = apmRootSpan.context().toTraceId(true)
            llmobs.trace({ kind: 'workflow' }, llmobsSpan1 => {
              traceId1 = LLMObsTagger.tagMap.get(llmobsSpan1)['_ml_obs.trace_id']
            })

            llmobs.trace({ kind: 'workflow' }, llmobsSpan2 => {
              traceId2 = LLMObsTagger.tagMap.get(llmobsSpan2)['_ml_obs.trace_id']
            })
          })

          assert.notStrictEqual(traceId1, traceId2)
          assert.notStrictEqual(traceId1, apmTraceId)
          assert.notStrictEqual(traceId2, apmTraceId)
        })

        it('maintains the llmobs parentage when error callbacks are used', () => {
          llmobs.trace({ kind: 'workflow' }, outer => {
            llmobs.trace({ kind: 'task' }, (inner, cb) => {
              assert.strictEqual(llmobs._active(), inner)
              assert.strictEqual(LLMObsTagger.tagMap.get(inner)['_ml_obs.llmobs_parent_id'], outer.context().toSpanId())
              cb() // finish the span
            })

            assert.strictEqual(llmobs._active(), outer)

            llmobs.trace({ kind: 'task' }, (inner) => {
              assert.strictEqual(llmobs._active(), inner)
              assert.strictEqual(LLMObsTagger.tagMap.get(inner)['_ml_obs.llmobs_parent_id'], outer.context().toSpanId())
            })
          })
        })
      })

      it('passes the options to the tagger correctly', () => {
        let span
        llmobs.trace({
          kind: 'workflow',
          name: 'test',
          mlApp: 'override',
          sessionId: 'sessionId',
          modelName: 'modelName',
          modelProvider: 'modelProvider',
        }, (_span) => {
          span = _span
        })

        assertObjectContains(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
          '_ml_obs.meta.span.kind': 'workflow',
          '_ml_obs.meta.ml_app': 'override',
          '_ml_obs.meta.model_name': 'modelName',
          '_ml_obs.meta.model_provider': 'modelProvider',
          '_ml_obs.session_id': 'sessionId',
          '_ml_obs.llmobs_parent_id': 'undefined',
        })
      })

      describe('bridge tags for otel correlation', () => {
        it('writes llmobs_trace_id and llmobs_parent_id to _trace.tags on first sdk activate', () => {
          llmobs.trace({ kind: 'workflow', name: 'wf' }, span => {
            const traceTags = span.context()._trace.tags
            const llmobsTraceId = LLMObsTagger.tagMap.get(span)['_ml_obs.trace_id']

            assert.strictEqual(traceTags.llmobs_trace_id, llmobsTraceId)
          })
        })

        it('does not overwrite bridge tags on nested sdk activates', () => {
          llmobs.trace({ kind: 'workflow', name: 'outer' }, outer => {
            const outerTraceId = outer.context()._trace.tags.llmobs_trace_id
            const outerParentId = outer.context()._trace.tags.llmobs_parent_id

            llmobs.trace({ kind: 'task', name: 'inner' }, inner => {
              assert.strictEqual(inner.context()._trace.tags.llmobs_trace_id, outerTraceId)
              assert.strictEqual(inner.context()._trace.tags.llmobs_parent_id, outerParentId)
              // sanity: the inner sdk span is NOT the bridge parent
              assert.notStrictEqual(outerParentId, inner.context().toSpanId())
            })
          })
        })

        it('does not overwrite bridge tags on sibling workflows under the same apm root', () => {
          tracer.trace('apmRoot', () => {
            let firstTraceId, firstParentId
            llmobs.trace({ kind: 'workflow', name: 'first' }, span => {
              firstTraceId = span.context()._trace.tags.llmobs_trace_id
              firstParentId = span.context()._trace.tags.llmobs_parent_id
            })
            llmobs.trace({ kind: 'workflow', name: 'second' }, span => {
              // sibling workflow keeps the first workflow's bridge tags
              assert.strictEqual(span.context()._trace.tags.llmobs_trace_id, firstTraceId)
              assert.strictEqual(span.context()._trace.tags.llmobs_parent_id, firstParentId)
            })
          })
        })

        it('writes bridge tags only when an llmobs span starts (not on plain apm spans)', () => {
          tracer.trace('plainApm', span => {
            assert.strictEqual(span.context()._trace.tags.llmobs_trace_id, undefined)
            assert.strictEqual(span.context()._trace.tags.llmobs_parent_id, undefined)
          })
        })

        it('writes the trace id as a 32-char hex string', () => {
          llmobs.trace({ kind: 'workflow', name: 'wf' }, span => {
            const traceId = span.context()._trace.tags.llmobs_trace_id
            assert.match(traceId, /^[0-9a-f]{32}$/)
          })
        })
      })
    })

    describe('wrap', () => {
      describe('tracing behavior', () => {
        it('starts a span if llmobs is disabled but does not process it in the LLMObs span processor', () => {
          tracer._tracer._config.llmobs.DD_LLMOBS_ENABLED = false

          const fn = llmobs.wrap({ kind: 'workflow' }, (a) => {
            assert.strictEqual(a, 1)
            const tag = LLMObsTagger.tagMap.get(llmobs._active())
            assert.ok(tag == null, `Expected no LLMObs tag for active span, got ${inspect(tag)}`)
          })

          fn(1)

          sinon.assert.called(llmobs._tracer._processor.process)
          sinon.assert.notCalled(LLMObsSpanProcessor.prototype.format)

          tracer._tracer._config.llmobs.DD_LLMOBS_ENABLED = true
        })

        it('throws if the kind is invalid', () => {
          assert.throws(() => llmobs.wrap({ kind: 'invalid' }, () => {}))
        })

        it('wraps a function', () => {
          let span
          const fn = llmobs.wrap({ kind: 'workflow' }, () => {
            span = tracer.scope().active()
            sinon.spy(span, 'finish')
          })

          fn()

          sinon.assert.called(span.finish)
        })

        it('wraps a function with a callback', () => {
          let span
          let next

          const fn = llmobs.wrap({ kind: 'workflow' }, (_next) => {
            span = tracer.scope().active()
            sinon.spy(span, 'finish')
            next = _next
          })

          fn(() => {})

          sinon.assert.notCalled(span.finish)

          next()

          sinon.assert.called(span.finish)
        })

        it('does not auto-annotate llm spans', () => {
          let span
          function myLLM (input) {
            span = llmobs._active()
            return ''
          }

          const wrappedMyLLM = llmobs.wrap({ kind: 'llm' }, myLLM)

          wrappedMyLLM('input')

          assertObjectContains(LLMObsTagger.tagMap.get(span), {
            '_ml_obs.sample_rate': '1',
            '_ml_obs.sampling_decision': '1',
            '_ml_obs.meta.span.kind': 'llm',
            '_ml_obs.meta.ml_app': 'mlApp',
            '_ml_obs.llmobs_parent_id': 'undefined',
          })
        })

        it('does not auto-annotate embedding spans input', () => {
          let span
          function myEmbedding (input) {
            span = llmobs._active()
            return 'output'
          }

          const wrappedMyEmbedding = llmobs.wrap({ kind: 'embedding' }, myEmbedding)

          wrappedMyEmbedding('input')

          assertObjectContains(LLMObsTagger.tagMap.get(span), {
            '_ml_obs.sample_rate': '1',
            '_ml_obs.sampling_decision': '1',
            '_ml_obs.meta.span.kind': 'embedding',
            '_ml_obs.meta.ml_app': 'mlApp',
            '_ml_obs.llmobs_parent_id': 'undefined',
            '_ml_obs.meta.output.value': 'output',
          })
        })

        it('does not auto-annotate retrieval spans output', () => {
          let span
          function myRetrieval (input) {
            span = llmobs._active()
            return 'output'
          }

          const wrappedMyRetrieval = llmobs.wrap({ kind: 'retrieval' }, myRetrieval)

          wrappedMyRetrieval('input')

          assertObjectContains(LLMObsTagger.tagMap.get(span), {
            '_ml_obs.sample_rate': '1',
            '_ml_obs.sampling_decision': '1',
            '_ml_obs.meta.span.kind': 'retrieval',
            '_ml_obs.meta.ml_app': 'mlApp',
            '_ml_obs.llmobs_parent_id': 'undefined',
            '_ml_obs.meta.input.value': 'input',
          })
        })

        it('does not crash for auto-annotation values that are overriden', () => {
          const circular = {}
          circular.circular = circular

          let span
          function myWorkflow (input) {
            span = llmobs._active()
            llmobs.annotate({
              inputData: 'circular',
              outputData: 'foo',
            })
            return ''
          }

          const wrappedMyWorkflow = llmobs.wrap({ kind: 'workflow' }, myWorkflow)
          wrappedMyWorkflow(circular)

          assertObjectContains(LLMObsTagger.tagMap.get(span), {
            '_ml_obs.sample_rate': '1',
            '_ml_obs.sampling_decision': '1',
            '_ml_obs.meta.span.kind': 'workflow',
            '_ml_obs.meta.ml_app': 'mlApp',
            '_ml_obs.llmobs_parent_id': 'undefined',
            '_ml_obs.meta.input.value': 'circular',
            '_ml_obs.meta.output.value': 'foo',
          })
        })

        it('only auto-annotates input on error', () => {
          let span
          function myTask (foo, bar) {
            span = llmobs._active()
            throw new Error('error')
          }

          const wrappedMyTask = llmobs.wrap({ kind: 'task' }, myTask)

          assert.throws(() => wrappedMyTask('foo', 'bar'))

          assertObjectContains(LLMObsTagger.tagMap.get(span), {
            '_ml_obs.sample_rate': '1',
            '_ml_obs.sampling_decision': '1',
            '_ml_obs.meta.span.kind': 'task',
            '_ml_obs.meta.ml_app': 'mlApp',
            '_ml_obs.llmobs_parent_id': 'undefined',
            '_ml_obs.meta.input.value': JSON.stringify({ foo: 'foo', bar: 'bar' }),
          })
        })

        it('only auto-annotates input on error for promises', () => {
          let span
          function myTask (foo, bar) {
            span = llmobs._active()
            return Promise.reject(new Error('error'))
          }

          const wrappedMyTask = llmobs.wrap({ kind: 'task' }, myTask)

          return wrappedMyTask('foo', 'bar')
            .catch(() => {
              assertObjectContains(LLMObsTagger.tagMap.get(span), {
                '_ml_obs.sample_rate': '1',
                '_ml_obs.sampling_decision': '1',
                '_ml_obs.meta.span.kind': 'task',
                '_ml_obs.meta.ml_app': 'mlApp',
                '_ml_obs.llmobs_parent_id': 'undefined',
                '_ml_obs.meta.input.value': JSON.stringify({ foo: 'foo', bar: 'bar' }),
              })
            })
        })

        it('auto-annotates the inputs of the callback function as the outputs for the span', () => {
          let span
          function myWorkflow (input, cb) {
            span = llmobs._active()
            setTimeout(() => {
              cb(null, 'output')
            }, 1000)
          }

          const wrappedMyWorkflow = llmobs.wrap({ kind: 'workflow' }, myWorkflow)
          wrappedMyWorkflow('input', (err, res) => {
            assert.ok(err == null, `Expected ${err} == null`)
            assert.strictEqual(res, 'output')
          })

          clock.tick(1000)

          assertObjectContains(LLMObsTagger.tagMap.get(span), {
            '_ml_obs.sample_rate': '1',
            '_ml_obs.sampling_decision': '1',
            '_ml_obs.meta.span.kind': 'workflow',
            '_ml_obs.meta.ml_app': 'mlApp',
            '_ml_obs.llmobs_parent_id': 'undefined',
            '_ml_obs.meta.input.value': JSON.stringify({ input: 'input' }),
            '_ml_obs.meta.output.value': 'output',
          })
        })

        it('ignores the error portion of the callback for auto-annotation', () => {
          let span
          function myWorkflow (input, cb) {
            span = llmobs._active()
            setTimeout(() => {
              cb(new Error('error'), 'output')
            }, 1000)
          }

          const wrappedMyWorkflow = llmobs.wrap({ kind: 'workflow' }, myWorkflow)
          wrappedMyWorkflow('input', (err, res) => {
            assert.ok(err)
            assert.strictEqual(res, 'output')
          })

          clock.tick(1000)

          assertObjectContains(LLMObsTagger.tagMap.get(span), {
            '_ml_obs.sample_rate': '1',
            '_ml_obs.sampling_decision': '1',
            '_ml_obs.meta.span.kind': 'workflow',
            '_ml_obs.meta.ml_app': 'mlApp',
            '_ml_obs.llmobs_parent_id': 'undefined',
            '_ml_obs.meta.input.value': JSON.stringify({ input: 'input' }),
            '_ml_obs.meta.output.value': 'output',
          })
        })

        it('auto-annotates the first argument of the callback as the output if it is not an error', () => {
          let span
          function myWorkflow (input, cb) {
            span = llmobs._active()
            setTimeout(() => {
              cb('output', 'ignore') // eslint-disable-line n/no-callback-literal
            }, 1000)
          }

          const wrappedMyWorkflow = llmobs.wrap({ kind: 'workflow' }, myWorkflow)
          wrappedMyWorkflow('input', (res, irrelevant) => {
            assert.strictEqual(res, 'output')
            assert.strictEqual(irrelevant, 'ignore')
          })

          clock.tick(1000)

          assertObjectContains(LLMObsTagger.tagMap.get(span), {
            '_ml_obs.sample_rate': '1',
            '_ml_obs.sampling_decision': '1',
            '_ml_obs.meta.span.kind': 'workflow',
            '_ml_obs.meta.ml_app': 'mlApp',
            '_ml_obs.llmobs_parent_id': 'undefined',
            '_ml_obs.meta.input.value': JSON.stringify({ input: 'input' }),
            '_ml_obs.meta.output.value': 'output',
          })
        })

        it('maintains context consistent with the tracer', () => {
          let llmSpan, workflowSpan, taskSpan

          function myLlm (input, cb) {
            llmSpan = llmobs._active()
            setTimeout(() => {
              cb(null, 'output')
            }, 1000)
          }
          const myWrappedLlm = llmobs.wrap({ kind: 'llm' }, myLlm)

          llmobs.trace({ kind: 'workflow', name: 'myWorkflow' }, _workflow => {
            workflowSpan = _workflow
            tracer.trace('apmOperation', () => {
              myWrappedLlm('input', (err, res) => {
                assert.ok(err == null, `Expected ${err} == null`)
                assert.strictEqual(res, 'output')
                llmobs.trace({ kind: 'task', name: 'afterLlmTask' }, _task => {
                  taskSpan = _task

                  const llmParentId = LLMObsTagger.tagMap.get(llmSpan)['_ml_obs.llmobs_parent_id']
                  assert.strictEqual(llmParentId, workflowSpan.context().toSpanId())

                  const taskParentId = LLMObsTagger.tagMap.get(taskSpan)['_ml_obs.llmobs_parent_id']
                  assert.strictEqual(taskParentId, workflowSpan.context().toSpanId())
                })
              })
            })
          })
        })

        // TODO: need span kind optional for this test
        it.skip('sets the span name to "unnamed-anonymous-function" if no name is provided', () => {
          let span
          const fn = llmobs.wrap({ kind: 'workflow' }, () => {
            span = llmobs._active()
          })

          fn()

          assert.strictEqual(span.context()._name, 'unnamed-anonymous-function')
        })
      })

      describe('parentage', () => {
        it('starts a span with a distinct trace id', () => {
          let span
          const fn = llmobs.wrap({ kind: 'workflow', name: 'test' }, () => {
            span = llmobs._active()
          })

          fn()

          const llmobsTraceId = LLMObsTagger.tagMap.get(span)['_ml_obs.trace_id']
          assert.ok(llmobsTraceId)
          assert.notStrictEqual(llmobsTraceId, span.context().toTraceId(true))
        })

        it('sets span parentage correctly', () => {
          let outerLLMSpan, innerLLMSpan

          function outer () {
            outerLLMSpan = llmobs._active()
            innerWrapped()
          }

          function inner () {
            innerLLMSpan = llmobs._active()
            assert.strictEqual(
              LLMObsTagger.tagMap.get(innerLLMSpan)['_ml_obs.llmobs_parent_id'],
              outerLLMSpan.context().toSpanId()
            )

            assert.equal(
              LLMObsTagger.tagMap.get(innerLLMSpan)['_ml_obs.trace_id'],
              LLMObsTagger.tagMap.get(outerLLMSpan)['_ml_obs.trace_id']
            )
          }

          const outerWrapped = llmobs.wrap({ kind: 'workflow' }, outer)
          const innerWrapped = llmobs.wrap({ kind: 'task' }, inner)

          outerWrapped()
        })

        it('maintains llmobs parentage separately from apm spans', () => {
          let outerLLMObsSpan, innerLLMObsSpan

          function outerLLMObs () {
            outerLLMObsSpan = llmobs._active()
            assert.strictEqual(outerLLMObsSpan, tracer.scope().active())

            apmWrapped()
          }
          function apm () {
            assert.strictEqual(llmobs._active(), outerLLMObsSpan)
            innerWrapped()
          }
          function innerLLMObs () {
            innerLLMObsSpan = llmobs._active()
            assert.strictEqual(innerLLMObsSpan, tracer.scope().active())
            assert.strictEqual(
              LLMObsTagger.tagMap.get(innerLLMObsSpan)['_ml_obs.llmobs_parent_id'],
              outerLLMObsSpan.context().toSpanId()
            )

            assert.equal(
              LLMObsTagger.tagMap.get(innerLLMObsSpan)['_ml_obs.trace_id'],
              LLMObsTagger.tagMap.get(outerLLMObsSpan)['_ml_obs.trace_id']
            )
          }

          const outerWrapped = llmobs.wrap({ kind: 'workflow' }, outerLLMObs)
          const apmWrapped = tracer.wrap('workflow', apm)
          const innerWrapped = llmobs.wrap({ kind: 'workflow' }, innerLLMObs)

          outerWrapped()
        })

        it('starts different traces for llmobs spans as child spans of an apm root span', () => {
          let traceId1, traceId2, apmTraceId
          function apm () {
            apmTraceId = tracer.scope().active().context().toTraceId(true)
            llmObsWrapped1()
            llmObsWrapped2()
          }
          function llmObs1 () {
            traceId1 = LLMObsTagger.tagMap.get(llmobs._active())['_ml_obs.trace_id']
          }
          function llmObs2 () {
            traceId2 = LLMObsTagger.tagMap.get(llmobs._active())['_ml_obs.trace_id']
          }

          const apmWrapped = tracer.wrap('workflow', apm)
          const llmObsWrapped1 = llmobs.wrap({ kind: 'workflow' }, llmObs1)
          const llmObsWrapped2 = llmobs.wrap({ kind: 'workflow' }, llmObs2)

          apmWrapped()

          assert.notStrictEqual(traceId1, traceId2)
          assert.notStrictEqual(traceId1, apmTraceId)
          assert.notStrictEqual(traceId2, apmTraceId)
        })

        it('maintains the llmobs parentage when callbacks are used', () => {
          let outerSpan
          function outer () {
            outerSpan = llmobs._active()
            wrappedInner1(() => {})
            assert.strictEqual(outerSpan, tracer.scope().active())
            wrappedInner2()
          }

          function inner1 (cb) {
            const inner = tracer.scope().active()
            assert.strictEqual(llmobs._active(), inner)
            assert.strictEqual(
              LLMObsTagger.tagMap.get(inner)['_ml_obs.llmobs_parent_id'],
              outerSpan.context().toSpanId()
            )
            cb()
          }

          function inner2 () {
            const inner = tracer.scope().active()
            assert.strictEqual(llmobs._active(), inner)
            assert.strictEqual(
              LLMObsTagger.tagMap.get(inner)['_ml_obs.llmobs_parent_id'],
              outerSpan.context().toSpanId()
            )
          }

          const wrappedOuter = llmobs.wrap({ kind: 'workflow' }, outer)
          const wrappedInner1 = llmobs.wrap({ kind: 'task' }, inner1)
          const wrappedInner2 = llmobs.wrap({ kind: 'task' }, inner2)

          wrappedOuter()
        })
      })

      it('passes the options to the tagger correctly', () => {
        let span

        const fn = llmobs.wrap({
          kind: 'workflow',
          name: 'test',
          mlApp: 'override',
          sessionId: 'sessionId',
          modelName: 'modelName',
          modelProvider: 'modelProvider',
        }, () => {
          span = llmobs._active()
        })

        fn()

        assertObjectContains(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
          '_ml_obs.meta.span.kind': 'workflow',
          '_ml_obs.meta.ml_app': 'override',
          '_ml_obs.meta.model_name': 'modelName',
          '_ml_obs.meta.model_provider': 'modelProvider',
          '_ml_obs.session_id': 'sessionId',
          '_ml_obs.llmobs_parent_id': 'undefined',
        })
      })
    })
  })

  describe('annotate', () => {
    it('returns if llmobs is disabled', () => {
      tracer._tracer._config.llmobs.DD_LLMOBS_ENABLED = false
      sinon.spy(llmobs, '_active')
      llmobs.annotate()

      sinon.assert.notCalled(llmobs._active)
      llmobs._active.restore()

      tracer._tracer._config.llmobs.DD_LLMOBS_ENABLED = true
    })

    it('throws if no arguments are provided', () => {
      assert.throws(() => llmobs.annotate())
    })

    it('throws if there are no options given', () => {
      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        assert.throws(() => llmobs.annotate(span))

        // span should still exist in the registry, just with no annotations
        assertObjectContains(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
        })
      })
    })

    it('throws if the provided span is not an LLMObs span', () => {
      tracer.trace('test', span => {
        assert.throws(() => llmobs.annotate(span, {}))

        const tag = LLMObsTagger.tagMap.get(span)
        assert.ok(tag == null, `Expected no LLMObs tag for span, got ${inspect(tag)}`)
      })
    })

    it('throws if the span is finished', () => {
      sinon.spy(llmobs._tagger, 'tagTextIO')
      llmobs.trace({ kind: 'workflow', name: 'outer' }, () => {
        let innerLLMSpan
        llmobs.trace({ kind: 'task', name: 'inner' }, _span => {
          innerLLMSpan = _span
        })

        assert.throws(() => llmobs.annotate(innerLLMSpan, {}))
        sinon.assert.notCalled(llmobs._tagger.tagTextIO)
      })
      llmobs._tagger.tagTextIO.restore()
    })

    it('throws for an llmobs span with an invalid kind', () => {
      // TODO this might end up being obsolete with llmobs span kind as optional
      sinon.spy(llmobs._tagger, 'tagLLMIO')
      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        LLMObsTagger.tagMap.get(span)['_ml_obs.meta.span.kind'] = undefined // somehow this is set
        assert.throws(() => llmobs.annotate(span, {}))
      })

      sinon.assert.notCalled(llmobs._tagger.tagLLMIO)
      llmobs._tagger.tagLLMIO.restore()
    })

    it('annotates the current active llmobs span in an llmobs scope', () => {
      sinon.spy(llmobs._tagger, 'tagTextIO')

      llmobs.trace({ kind: 'workflow', name: 'test' }, span => {
        const inputData = {}
        llmobs.annotate({ inputData })

        sinon.assert.calledWith(llmobs._tagger.tagTextIO, span, inputData, undefined)
      })

      llmobs._tagger.tagTextIO.restore()
    })

    it('annotates the current active llmobs span in an apm scope', () => {
      sinon.spy(llmobs._tagger, 'tagTextIO')

      llmobs.trace({ kind: 'workflow', name: 'test' }, llmobsSpan => {
        tracer.trace('apmSpan', () => {
          const inputData = {}
          llmobs.annotate({ inputData })

          sinon.assert.calledWith(llmobs._tagger.tagTextIO, llmobsSpan, inputData, undefined)
        })
      })

      llmobs._tagger.tagTextIO.restore()
    })

    it('annotates llm io for an llm span', () => {
      const inputData = [{ role: 'system', content: 'system prompt' }]
      const outputData = [{ role: 'ai', content: 'no question was asked' }]

      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        llmobs.annotate({ inputData, outputData })

        assertObjectContains(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.meta.input.messages': inputData,
          '_ml_obs.meta.output.messages': outputData,
        })
      })
    })

    it('annotates llm io with audio parts for an llm span', () => {
      const inputData = [
        { role: 'user', content: 'transcribe this', audioParts: [{ mimeType: 'audio/wav', content: 'aGVsbG8=' }] },
      ]
      const outputData = [
        { role: 'assistant', content: 'sure', audioParts: [{ mimeType: 'audio/mpeg', attachmentKey: 'key-123' }] },
      ]

      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        llmobs.annotate({ inputData, outputData })

        assertObjectContains(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.meta.input.messages': [
            {
              role: 'user',
              content: 'transcribe this',
              audio_parts: [{ mime_type: 'audio/wav', content: 'aGVsbG8=' }],
            },
          ],
          '_ml_obs.meta.output.messages': [
            {
              role: 'assistant',
              content: 'sure',
              audio_parts: [{ mime_type: 'audio/mpeg', attachment_key: 'key-123' }],
            },
          ],
        })
      })
    })

    it('annotates llm io with image parts for an llm span', () => {
      const inputData = [
        { role: 'user', content: 'describe this', imageParts: [{ mimeType: 'image/png', content: 'iVBORw0KGgo=' }] },
      ]
      const outputData = [
        { role: 'assistant', content: 'bands', imageParts: [{ mimeType: 'image/jpeg', attachmentKey: 'key-123' }] },
      ]

      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        llmobs.annotate({ inputData, outputData })

        assertObjectContains(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.meta.input.messages': [
            {
              role: 'user',
              content: 'describe this',
              image_parts: [{ mime_type: 'image/png', content: 'iVBORw0KGgo=' }],
            },
          ],
          '_ml_obs.meta.output.messages': [
            {
              role: 'assistant',
              content: 'bands',
              image_parts: [{ mime_type: 'image/jpeg', attachment_key: 'key-123' }],
            },
          ],
        })
      })
    })

    it('annotates embedding io for an embedding span', () => {
      const inputData = [{ text: 'input text' }]
      const outputData = 'documents embedded'

      llmobs.trace({ kind: 'embedding', name: 'test' }, span => {
        llmobs.annotate({ inputData, outputData })

        assertObjectContains(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
          '_ml_obs.meta.span.kind': 'embedding',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.meta.input.documents': inputData,
          '_ml_obs.meta.output.value': outputData,
        })
      })
    })

    it('annotates retrieval io for a retrieval span', () => {
      const inputData = 'input text'
      const outputData = [{ text: 'output text' }]

      llmobs.trace({ kind: 'retrieval', name: 'test' }, span => {
        llmobs.annotate({ inputData, outputData })

        assertObjectContains(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
          '_ml_obs.meta.span.kind': 'retrieval',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.meta.input.value': inputData,
          '_ml_obs.meta.output.documents': outputData,
        })
      })
    })

    it('annotates metadata if present', () => {
      const metadata = { response_type: 'json' }

      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        llmobs.annotate({ metadata })

        assertObjectContains(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.meta.metadata': metadata,
        })
      })
    })

    it('annotates metrics if present', () => {
      const metrics = { score: 0.6 }

      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        llmobs.annotate({ metrics })

        assertObjectContains(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.metrics': metrics,
        })
      })
    })

    it('annotates tags if present', () => {
      const tags = { 'custom.tag': 'value' }

      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        llmobs.annotate({ tags })

        assertObjectContains(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.tags': tags,
        })
      })
    })

    it('annotates costTags if present', () => {
      const tags = { team: 'ml', feature: 'chatbot', debug_id: 'abc' }

      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        llmobs.annotate({ tags, costTags: ['team', 'feature'] })

        assertObjectContains(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.tags': tags,
          '_ml_obs.meta.metadata._dd.cost_tags': ['team', 'feature'],
        })
      })
    })

    it('dedupes costTags across annotations', () => {
      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        llmobs.annotate({
          tags: { team: 'ml', feature: 'chatbot' },
          costTags: ['team', 'feature', 'team'],
        })
        llmobs.annotate({
          tags: { project: 'alpha' },
          costTags: ['feature', 'project'],
        })

        assertObjectContains(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.tags': { team: 'ml', feature: 'chatbot', project: 'alpha' },
          '_ml_obs.meta.metadata._dd.cost_tags': ['team', 'feature', 'project'],
        })
      })
    })

    it('skips invalid costTags entries', () => {
      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        llmobs.annotate({ tags: { team: 'ml' }, costTags: ['team', 'missing', 123] })

        assertObjectContains(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.tags': { team: 'ml' },
          '_ml_obs.meta.metadata._dd.cost_tags': ['team'],
        })
      })
    })

    it('rejects non-array costTags', () => {
      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        llmobs.annotate({ tags: { team: 'ml' }, costTags: 'team' })

        assertObjectContains(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.tags': { team: 'ml' },
        })
      })
    })

    it('does not set costTags for an empty list', () => {
      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        llmobs.annotate({ tags: { team: 'ml' }, costTags: [] })

        assertObjectContains(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.tags': { team: 'ml' },
        })
      })
    })

    it('ignores null costTags', () => {
      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        llmobs.annotate({ tags: { team: 'ml' }, costTags: null })

        assertObjectContains(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.tags': { team: 'ml' },
        })
      })
    })

    it('annotates toolDefinitions if present', () => {
      const toolDefinitions = [
        { name: 'get_weather', description: 'Gets the weather', schema: { type: 'object' }, version: '1.0' },
        { name: 'get_time' },
      ]

      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        llmobs.annotate({ toolDefinitions })

        assertObjectContains(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.meta.tool_definitions': toolDefinitions,
        })
      })
    })

    it('strips invalid optional fields from toolDefinitions items', () => {
      const toolDefinitions = [
        { name: 'get_weather', description: 123, schema: 'not-an-object', version: 456 },
      ]

      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        llmobs.annotate({ toolDefinitions })

        assertObjectContains(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.meta.tool_definitions': [{ name: 'get_weather' }],
        })
      })
    })

    it('skips toolDefinitions items missing a name', () => {
      const toolDefinitions = [
        { description: 'no name here' },
        { name: 'valid_tool' },
      ]

      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        llmobs.annotate({ toolDefinitions })

        assertObjectContains(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.sample_rate': '1',
          '_ml_obs.sampling_decision': '1',
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.meta.tool_definitions': [{ name: 'valid_tool' }],
        })
      })
    })

    it('rejects non array toolDefinitions', () => {
      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        assert.throws(() => llmobs.annotate({ toolDefinitions: 'not an array' }))
      })
    })

    it('rejects empty toolDefinitions array', () => {
      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        assert.throws(() => llmobs.annotate({ toolDefinitions: [] }))
      })
    })

    it('rejects toolDefinitions where all items are invalid', () => {
      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        assert.throws(() => llmobs.annotate({ toolDefinitions: [{ description: 'no name' }, 'not an object'] }))
      })
    })
  })

  describe('annotationContext', () => {
    it('applies costTags to spans created in the context', () => {
      llmobs.annotationContext({ tags: { team: 'ml', feature: 'chatbot' }, costTags: ['team', 'feature'] }, () => {
        llmobs.trace({ kind: 'llm', name: 'test' }, span => {
          assertObjectContains(LLMObsTagger.tagMap.get(span), {
            '_ml_obs.sample_rate': '1',
            '_ml_obs.sampling_decision': '1',
            '_ml_obs.meta.span.kind': 'llm',
            '_ml_obs.meta.ml_app': 'mlApp',
            '_ml_obs.llmobs_parent_id': 'undefined',
            '_ml_obs.tags': { team: 'ml', feature: 'chatbot' },
            '_ml_obs.meta.metadata._dd.cost_tags': ['team', 'feature'],
          })
        })
      })
    })

    it('does not retain costTags for tags added after the span starts', () => {
      llmobs.annotationContext({ costTags: ['team'] }, () => {
        llmobs.trace({ kind: 'llm', name: 'test' }, span => {
          llmobs.annotate({ tags: { team: 'ml' } })

          assertObjectContains(LLMObsTagger.tagMap.get(span), {
            '_ml_obs.sample_rate': '1',
            '_ml_obs.sampling_decision': '1',
            '_ml_obs.meta.span.kind': 'llm',
            '_ml_obs.meta.ml_app': 'mlApp',
            '_ml_obs.llmobs_parent_id': 'undefined',
            '_ml_obs.tags': { team: 'ml' },
          })
        })
      })
    })
  })

  it('annotates toolDefinitions if present', () => {
    const toolDefinitions = [
      { name: 'get_weather', description: 'Gets the weather', schema: { type: 'object' }, version: '1.0' },
      { name: 'get_time' },
    ]

    llmobs.trace({ kind: 'llm', name: 'test' }, span => {
      llmobs.annotate({ toolDefinitions })
      assert.deepStrictEqual(LLMObsTagger.tagMap.get(span)['_ml_obs.meta.tool_definitions'], toolDefinitions)
    })
  })

  it('rejects non array toolDefinitions', () => {
    llmobs.trace({ kind: 'llm', name: 'test' }, span => {
      assert.throws(() => llmobs.annotate({ toolDefinitions: 'not an array' }))
    })
  })

  it('rejects empty toolDefinitions array', () => {
    llmobs.trace({ kind: 'llm', name: 'test' }, span => {
      assert.throws(() => llmobs.annotate({ toolDefinitions: [] }))
    })
  })

  describe('exportSpan', () => {
    it('throws if no span is provided', () => {
      assert.throws(() => llmobs.exportSpan())
    })

    it('throws if the provided span is not an LLMObs span', () => {
      tracer.trace('test', span => {
        assert.throws(() => llmobs.exportSpan(span))
      })
    })

    it('uses the provided span', () => {
      llmobs.trace({ kind: 'workflow', name: 'test' }, span => {
        const spanCtx = llmobs.exportSpan(span)

        const traceId = LLMObsTagger.tagMap.get(span)['_ml_obs.trace_id']
        const spanId = span.context().toSpanId()

        assert.deepStrictEqual(spanCtx, { traceId, spanId })
      })
    })

    it('uses the active span in an llmobs scope', () => {
      llmobs.trace({ kind: 'workflow', name: 'test' }, span => {
        const spanCtx = llmobs.exportSpan()

        const traceId = LLMObsTagger.tagMap.get(span)['_ml_obs.trace_id']
        const spanId = span.context().toSpanId()

        assert.deepStrictEqual(spanCtx, { traceId, spanId })
      })
    })

    it('uses the active span in an apm scope', () => {
      llmobs.trace({ kind: 'workflow', name: 'test' }, llmobsSpan => {
        tracer.trace('apmSpan', () => {
          const spanCtx = llmobs.exportSpan()

          const traceId = LLMObsTagger.tagMap.get(llmobsSpan)['_ml_obs.trace_id']
          const spanId = llmobsSpan.context().toSpanId()

          assert.deepStrictEqual(spanCtx, { traceId, spanId })
        })
      })
    })
  })

  describe('submitEvaluation', () => {
    let spanCtx
    let originalApiKey

    before(() => {
      originalApiKey = tracer._tracer._config.DD_API_KEY
      tracer._tracer._config.DD_API_KEY = 'test'
    })

    beforeEach(() => {
      spanCtx = {
        traceId: '1234',
        spanId: '5678',
      }
    })

    after(() => {
      tracer._tracer._config.DD_API_KEY = originalApiKey
    })

    it('does not submit an evaluation if llmobs is disabled', () => {
      tracer._tracer._config.llmobs.DD_LLMOBS_ENABLED = false
      llmobs.submitEvaluation()

      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)

      tracer._tracer._config.llmobs.DD_LLMOBS_ENABLED = true
    })

    it('throws for an invalid span context', () => {
      const invalid = {}

      assert.throws(() => llmobs.submitEvaluation(invalid, {}))
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('throws for a missing mlApp', () => {
      const mlApp = tracer._tracer._config.llmobs.mlApp
      delete tracer._tracer._config.llmobs.mlApp

      assert.throws(() => llmobs.submitEvaluation(spanCtx))
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)

      tracer._tracer._config.llmobs.mlApp = mlApp
    })

    it('throws for an invalid timestamp', () => {
      assert.throws(() => {
        llmobs.submitEvaluation(spanCtx, {
          mlApp: 'test',
          timestampMs: 'invalid',
        })
      })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('throws for a missing label', () => {
      assert.throws(() => {
        llmobs.submitEvaluation(spanCtx, {
          mlApp: 'test',
          timestampMs: 1234,
        })
      })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('sends a non-string label as-is', () => {
      llmobs.submitEvaluation(spanCtx, {
        mlApp: 'test',
        timestampMs: 1234,
        label: 1234,
        metricType: 'score',
        value: 0.6,
      })

      assert.strictEqual(LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0].label, 1234)
    })

    it('throws for non-object tags', () => {
      assert.throws(() => {
        llmobs.submitEvaluation(spanCtx, {
          mlApp: 'test',
          timestampMs: 1234,
          label: 'test',
          metricType: 'score',
          value: 0.6,
          tags: 'host',
        })
      }, { message: 'Failed to parse tags. Tags for evaluation metrics must be strings' })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('throws for a tag value that cannot be coerced to a string', () => {
      assert.throws(() => {
        llmobs.submitEvaluation(spanCtx, {
          mlApp: 'test',
          timestampMs: 1234,
          label: 'test',
          metricType: 'score',
          value: 0.6,
          tags: { host: Object.create(null) },
        })
      }, { message: 'Failed to parse tags. Tags for evaluation metrics must be strings' })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('serializes nullish tag values', () => {
      llmobs.submitEvaluation(spanCtx, {
        mlApp: 'test',
        timestampMs: 1234,
        label: 'test',
        metricType: 'score',
        value: 0.6,
        tags: { host: null, port: undefined },
      })

      assert.deepStrictEqual(
        LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0].tags,
        [`ddtrace.version:${tracerVersion}`, 'ml_app:test', 'host:null', 'port:undefined']
      )
    })

    it('coerces non-string tag values', () => {
      llmobs.submitEvaluation(spanCtx, {
        mlApp: 'test',
        timestampMs: 1234,
        label: 'test',
        metricType: 'score',
        value: 0.6,
        tags: { port: 8126 },
      })

      assert.deepStrictEqual(
        LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0].tags,
        [`ddtrace.version:${tracerVersion}`, 'ml_app:test', 'port:8126']
      )
    })

    it('throws for an invalid metric type', () => {
      assert.throws(() => {
        llmobs.submitEvaluation(spanCtx, {
          mlApp: 'test',
          timestampMs: 1234,
          label: 'test',
          metricType: 'invalid',
        })
      })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('throws for a mismatched value for a categorical metric', () => {
      assert.throws(() => {
        llmobs.submitEvaluation(spanCtx, {
          mlApp: 'test',
          timestampMs: 1234,
          label: 'test',
          metricType: 'categorical',
          value: 1,
        })
      })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('throws for a mismatched value for a score metric', () => {
      assert.throws(() => {
        llmobs.submitEvaluation(spanCtx, {
          mlApp: 'test',
          timestampMs: 1234,
          label: 'test',
          metricType: 'score',
          value: 'string',
        })
      })

      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('submits an evaluation metric', () => {
      llmobs.submitEvaluation(spanCtx, {
        mlApp: 'test',
        timestampMs: 1234,
        label: 'test',
        metricType: 'score',
        value: 0.6,
        tags: {
          host: 'localhost',
        },
      })

      assert.deepStrictEqual(LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0], {
        event_kind: 'evaluation',
        join_on: {
          span: {
            trace_id: spanCtx.traceId,
            span_id: spanCtx.spanId,
          },
        },
        ml_app: 'test',
        timestamp_ms: 1234,
        label: 'test',
        metric_type: 'score',
        score_value: 0.6,
        tags: [`ddtrace.version:${tracerVersion}`, 'ml_app:test', 'host:localhost'],
      })
    })

    it('sets `categorical_value` for categorical metrics', () => {
      llmobs.submitEvaluation(spanCtx, {
        mlApp: 'test',
        timestampMs: 1234,
        label: 'test',
        metricType: 'categorical',
        value: 'foo',
        tags: {
          host: 'localhost',
        },
      })

      assert.ok('categorical_value' in LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0])
      assert.strictEqual(LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0].categorical_value, 'foo')
    })

    describe('with no timestamp provided', () => {
      let prevTime

      before(() => {
        prevTime = clock.now
        clock.setSystemTime(1234)
      })

      after(() => {
        clock.setSystemTime(prevTime)
      })

      it('defaults to the current time', () => {
        llmobs.submitEvaluation(spanCtx, {
          mlApp: 'test',
          label: 'test',
          metricType: 'score',
          value: 0.6,
        })

        assert.ok('timestamp_ms' in LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0])
        assert.strictEqual(LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0].timestamp_ms, 1234)
      })
    })

    it('submits a boolean evaluation metric', () => {
      llmobs.submitEvaluation(spanCtx, {
        label: 'has_toxicity',
        metricType: 'boolean',
        value: true,
        timestampMs: 1234,
      })

      const evalMetric = LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0]

      assert.deepStrictEqual(evalMetric, {
        event_kind: 'evaluation',
        join_on: {
          span: {
            span_id: '5678',
            trace_id: '1234',
          },
        },
        label: 'has_toxicity',
        metric_type: 'boolean',
        ml_app: 'mlApp',
        boolean_value: true,
        timestamp_ms: 1234,
        tags: [`ddtrace.version:${tracerVersion}`, 'ml_app:mlApp'],
      })
    })

    it('throws an error when submitting a non-boolean boolean evaluation metric', () => {
      assert.throws(() => llmobs.submitEvaluation(spanCtx, {
        label: 'has_toxicity',
        metricType: 'boolean',
        value: 'it is super toxic!',
      }), { message: 'value must be a boolean for a boolean metric' })
    })

    it('submits a json evaluation metric', () => {
      llmobs.submitEvaluation(spanCtx, {
        label: 'has_toxicity',
        metricType: 'json',
        value: { f1: 0.8, recall: 1, precision: 0.5 },
        timestampMs: 1234,
      })

      const evalMetric = LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0]

      assert.deepStrictEqual(evalMetric, {
        event_kind: 'evaluation',
        join_on: {
          span: {
            span_id: '5678',
            trace_id: '1234',
          },
        },
        label: 'has_toxicity',
        metric_type: 'json',
        ml_app: 'mlApp',
        json_value: { f1: 0.8, recall: 1, precision: 0.5 },
        timestamp_ms: 1234,
        tags: [`ddtrace.version:${tracerVersion}`, 'ml_app:mlApp'],
      })
    })

    it('throws an error when submitting a non-JSON object json evaluation metric', () => {
      assert.throws(() => llmobs.submitEvaluation(spanCtx, {
        label: 'has_toxicity',
        metricType: 'json',
        value: 'it is super toxic!',
      }), { message: 'value must be a JSON object for a json metric' })
    })

    it('submits an enriched evaluation metric', () => {
      llmobs.submitEvaluation(spanCtx, {
        mlApp: 'test',
        timestampMs: 1234,
        label: 'toxic',
        metricType: 'score',
        value: 0.6,
        reasoning: 'this input is toxic',
        assessment: 'fail',
        metadata: { some: 'details' },
        tags: {
          host: 'localhost',
        },
      })

      assert.deepStrictEqual(LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0], {
        event_kind: 'evaluation',
        join_on: {
          span: {
            span_id: spanCtx.spanId,
            trace_id: spanCtx.traceId,
          },
        },
        ml_app: 'test',
        timestamp_ms: 1234,
        label: 'toxic',
        metric_type: 'score',
        score_value: 0.6,
        tags: [`ddtrace.version:${tracerVersion}`, 'ml_app:test', 'host:localhost'],
        reasoning: 'this input is toxic',
        assessment: 'fail',
        metadata: { some: 'details' },
      })
    })

    it('throws an error when submitting a non-string reasoning', () => {
      assert.throws(() => llmobs.submitEvaluation(spanCtx, {
        label: 'has_toxicity',
        metricType: 'boolean',
        value: true,
        reasoning: 1,
      }), { message: 'reasoning must be a string' })
    })

    it('throws an error when submitting a non pass/fail assessment', () => {
      assert.throws(() => llmobs.submitEvaluation(spanCtx, {
        label: 'has_toxicity',
        metricType: 'boolean',
        value: true,
        assessment: 'correct',
      }), { message: 'assessment must be pass or fail' })
    })

    it('throws an error when submitting an non JSON object metadata', () => {
      assert.throws(() => llmobs.submitEvaluation(spanCtx, {
        label: 'has_toxicity',
        metricType: 'boolean',
        value: true,
        metadata: 'some metadata',
      }), { message: 'metadata must be a JSON object' })
    })

    describe('with DD_TRACE_OTEL_ENABLED set', () => {
      let otelLLMObs

      before(() => {
        // DD_TRACE_OTEL_ENABLED is a launch-time env var captured when `Config` is built.
        // Build a fresh config with the env set, then wire up a sibling LLMObs SDK that uses it.
        // The outer `llmobs` is already enabled and its writers are already subscribed to the
        // channels, so we only need this SDK to hold a config that reports `enabled` and has
        // `DD_TRACE_OTEL_ENABLED` set - no extra enable()/disable() calls (which would trigger
        // flush() on the spied writer and pollute unrelated tests).
        process.env.DD_TRACE_OTEL_ENABLED = 'true'
        const config = getConfigFresh({ llmobs: { mlApp: 'mlApp', agentlessEnabled: false } })
        delete process.env.DD_TRACE_OTEL_ENABLED
        config.llmobs.DD_LLMOBS_ENABLED = true
        otelLLMObs = new LLMObsSDK(tracer._tracer, llmobsModule, config)
      })

      it('adds source:otel tag', () => {
        otelLLMObs.submitEvaluation(spanCtx, {
          mlApp: 'test',
          timestampMs: 1234,
          label: 'test',
          metricType: 'score',
          value: 0.6,
        })

        const evalMetric = LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0]
        assert.ok(evalMetric.tags.includes('source:otel'), 'Expected source:otel tag to be present')
      })
    })
  })

  describe('submitFeedback', () => {
    let submitter

    beforeEach(() => {
      submitter = { id: 'user-1', type: 'user' }
    })

    it('throws when no target is provided', () => {
      assert.throws(() => llmobs.submitFeedback({
        label: 'thumbs_up',
        metricType: 'boolean',
        value: true,
        submitter,
      }), {
        message: 'Exactly one of `span`, `spanId`, `traceId`, `sessionId` or `feedbackJoinKey` ' +
          'must be specified to submit feedback.',
      })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('throws when two targets are provided', () => {
      assert.throws(() => llmobs.submitFeedback({
        label: 'thumbs_up',
        metricType: 'boolean',
        value: true,
        submitter,
        spanId: '5678',
        sessionId: 'session-1',
      }), {
        message: 'Exactly one of `span`, `spanId`, `traceId`, `sessionId` or `feedbackJoinKey` ' +
          'must be specified to submit feedback.',
      })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    // An odd target count is what a parity check (`^`) would wrongly accept.
    it('throws when three targets are provided', () => {
      assert.throws(() => llmobs.submitFeedback({
        label: 'thumbs_up',
        metricType: 'boolean',
        value: true,
        submitter,
        spanId: '5678',
        traceId: '1234',
        sessionId: 'session-1',
      }), {
        message: 'Exactly one of `span`, `spanId`, `traceId`, `sessionId` or `feedbackJoinKey` ' +
          'must be specified to submit feedback.',
      })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('throws for a span without a spanId', () => {
      assert.throws(() => llmobs.submitFeedback({
        label: 'thumbs_up',
        metricType: 'boolean',
        value: true,
        submitter,
        span: { traceId: '1234' },
      }), {
        name: 'TypeError',
        message: '`span` must be an object containing a non-empty string spanId. ' +
          '`llmobs.exportSpan()` can be used to generate this object from a given span.',
      })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('throws for an empty target', () => {
      assert.throws(() => llmobs.submitFeedback({
        label: 'thumbs_up',
        metricType: 'boolean',
        value: true,
        submitter,
        sessionId: '',
      }), { name: 'TypeError', message: '`sessionId` must be a non-empty string' })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('throws for a non-string target', () => {
      assert.throws(() => llmobs.submitFeedback({
        label: 'thumbs_up',
        metricType: 'boolean',
        value: true,
        submitter,
        traceId: 1234,
      }), { name: 'TypeError', message: '`traceId` must be a non-empty string' })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('throws for a missing submitter', () => {
      assert.throws(() => llmobs.submitFeedback({
        label: 'thumbs_up',
        metricType: 'boolean',
        value: true,
        spanId: '5678',
      }), { name: 'TypeError', message: 'submitter must be an object containing a non-empty string id' })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('throws for a submitter without an id', () => {
      assert.throws(() => llmobs.submitFeedback({
        label: 'thumbs_up',
        metricType: 'boolean',
        value: true,
        submitter: { type: 'user' },
        spanId: '5678',
      }), { name: 'TypeError', message: 'submitter must be an object containing a non-empty string id' })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('throws for a non-string submitter type', () => {
      assert.throws(() => llmobs.submitFeedback({
        label: 'thumbs_up',
        metricType: 'boolean',
        value: true,
        submitter: { id: 'user-1', type: 1 },
        spanId: '5678',
      }), { name: 'TypeError', message: 'submitter.type must be a string' })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('throws for an invalid timestamp', () => {
      assert.throws(() => llmobs.submitFeedback({
        label: 'thumbs_up',
        metricType: 'boolean',
        value: true,
        submitter,
        spanId: '5678',
        timestampMs: 'invalid',
      }), { message: 'timestampMs must be a non-negative integer. Feedback data will not be sent' })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('throws for a missing label', () => {
      assert.throws(() => llmobs.submitFeedback({
        metricType: 'boolean',
        value: true,
        submitter,
        spanId: '5678',
      }), { message: 'label must be the specified name of the feedback metric' })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('throws for a dotted label', () => {
      assert.throws(() => llmobs.submitFeedback({
        label: 'thumbs.up',
        metricType: 'boolean',
        value: true,
        submitter,
        spanId: '5678',
      }), { message: 'label value must not contain a "."' })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('sends a non-string label as a string', () => {
      llmobs.submitFeedback({
        label: 1234,
        metricType: 'boolean',
        value: true,
        submitter,
        spanId: '5678',
        timestampMs: 1234,
      })

      assert.strictEqual(LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0].label, '1234')
    })

    it('throws for non-object tags', () => {
      assert.throws(() => llmobs.submitFeedback({
        label: 'thumbs_up',
        metricType: 'boolean',
        value: true,
        submitter,
        spanId: '5678',
        tags: ['host'],
      }), { message: 'Failed to parse tags. Tags for feedback metrics must be strings' })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('throws for a tag value that cannot be coerced to a string', () => {
      assert.throws(() => llmobs.submitFeedback({
        label: 'thumbs_up',
        metricType: 'boolean',
        value: true,
        submitter,
        spanId: '5678',
        tags: { host: Object.create(null) },
      }), { message: 'Failed to parse tags. Tags for feedback metrics must be strings' })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('serializes nullish tag values', () => {
      llmobs.submitFeedback({
        label: 'thumbs_up',
        metricType: 'boolean',
        value: true,
        submitter,
        spanId: '5678',
        timestampMs: 1234,
        tags: { host: null, port: undefined },
      })

      assert.deepStrictEqual(
        LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0].tags,
        [`ddtrace.version:${tracerVersion}`, 'ml_app:mlApp', 'host:null', 'port:undefined']
      )
    })

    it('throws for an invalid metric type', () => {
      assert.throws(() => llmobs.submitFeedback({
        label: 'thumbs_up',
        metricType: 'invalid',
        value: true,
        submitter,
        spanId: '5678',
      }), { message: 'metricType must be one of "categorical", "score", "boolean", "json" or "text"' })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('throws for a mismatched value for a text metric', () => {
      assert.throws(() => llmobs.submitFeedback({
        label: 'comment',
        metricType: 'text',
        value: 1,
        submitter,
        spanId: '5678',
      }), { message: 'value must be a string for a text metric' })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('throws for a mismatched value for a score metric', () => {
      assert.throws(() => llmobs.submitFeedback({
        label: 'rating',
        metricType: 'score',
        value: 'good',
        submitter,
        spanId: '5678',
      }), { message: 'value must be a number for a score metric.' })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('throws for a non pass/fail assessment', () => {
      assert.throws(() => llmobs.submitFeedback({
        label: 'thumbs_up',
        metricType: 'boolean',
        value: true,
        submitter,
        spanId: '5678',
        assessment: 'correct',
      }), { message: 'assessment must be pass or fail' })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('throws for a non-string reasoning', () => {
      assert.throws(() => llmobs.submitFeedback({
        label: 'thumbs_up',
        metricType: 'boolean',
        value: true,
        submitter,
        spanId: '5678',
        reasoning: 1,
      }), { message: 'reasoning must be a string' })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('submits feedback for a span id', () => {
      llmobs.submitFeedback({
        label: 'thumbs_up',
        metricType: 'boolean',
        value: true,
        submitter,
        spanId: '5678',
        mlApp: 'test',
        timestampMs: 1234,
        tags: { host: 'localhost' },
      })

      assert.deepStrictEqual(LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0], {
        event_kind: 'feedback',
        span_id: '5678',
        label: 'thumbs_up',
        metric_type: 'boolean',
        ml_app: 'test',
        boolean_value: true,
        timestamp_ms: 1234,
        tags: [`ddtrace.version:${tracerVersion}`, 'ml_app:test', 'host:localhost'],
        submitter: { id: 'user-1', type: 'user' },
      })
    })

    it('submits feedback for an exported span, using its span id only', () => {
      llmobs.submitFeedback({
        label: 'thumbs_up',
        metricType: 'boolean',
        value: true,
        submitter,
        span: { traceId: '1234', spanId: '5678' },
        timestampMs: 1234,
      })

      assert.deepStrictEqual(LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0], {
        event_kind: 'feedback',
        span_id: '5678',
        label: 'thumbs_up',
        metric_type: 'boolean',
        ml_app: 'mlApp',
        boolean_value: true,
        timestamp_ms: 1234,
        tags: [`ddtrace.version:${tracerVersion}`, 'ml_app:mlApp'],
        submitter: { id: 'user-1', type: 'user' },
      })
    })

    it('omits the submitter type when not provided', () => {
      llmobs.submitFeedback({
        label: 'thumbs_up',
        metricType: 'boolean',
        value: true,
        submitter: { id: 'user-1' },
        spanId: '5678',
        timestampMs: 1234,
      })

      assert.deepStrictEqual(
        LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0].submitter,
        { id: 'user-1' }
      )
    })

    it('submits enriched text feedback for a feedback join key', () => {
      llmobs.submitFeedback({
        label: 'comment',
        metricType: 'text',
        value: 'this answer was helpful',
        submitter,
        feedbackJoinKey: 'my-join-key',
        timestampMs: 1234,
        assessment: 'pass',
        reasoning: 'the user was satisfied',
      })

      assert.deepStrictEqual(LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0], {
        event_kind: 'feedback',
        feedback_join_key: 'my-join-key',
        label: 'comment',
        metric_type: 'text',
        ml_app: 'mlApp',
        text_value: 'this answer was helpful',
        timestamp_ms: 1234,
        tags: [`ddtrace.version:${tracerVersion}`, 'ml_app:mlApp'],
        submitter: { id: 'user-1', type: 'user' },
        assessment: 'pass',
        reasoning: 'the user was satisfied',
      })
    })

    it('submits feedback for a trace id', () => {
      llmobs.submitFeedback({
        label: 'rating',
        metricType: 'score',
        value: 0.5,
        submitter,
        traceId: '1234',
        timestampMs: 1234,
      })

      const feedback = LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0]
      assert.strictEqual(feedback.trace_id, '1234')
      assert.strictEqual(feedback.score_value, 0.5)
      assert.ok(!('span_id' in feedback))
    })

    it('submits feedback for a session id', () => {
      llmobs.submitFeedback({
        label: 'thumbs_up',
        metricType: 'categorical',
        value: 'up',
        submitter,
        sessionId: 'session-1',
        timestampMs: 1234,
      })

      const feedback = LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0]
      assert.strictEqual(feedback.session_id, 'session-1')
      assert.strictEqual(feedback.categorical_value, 'up')
    })

    describe('with no timestamp provided', () => {
      let prevTime

      before(() => {
        prevTime = clock.now
        clock.setSystemTime(1234)
      })

      after(() => {
        clock.setSystemTime(prevTime)
      })

      it('defaults to the current time', () => {
        llmobs.submitFeedback({
          label: 'thumbs_up',
          metricType: 'boolean',
          value: true,
          submitter,
          spanId: '5678',
        })

        assert.strictEqual(LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0].timestamp_ms, 1234)
      })
    })

    describe('with no mlApp configured', () => {
      let mlApp

      before(() => {
        mlApp = tracer._tracer._config.llmobs.mlApp
        delete tracer._tracer._config.llmobs.mlApp
      })

      after(() => {
        tracer._tracer._config.llmobs.mlApp = mlApp
      })

      it('throws', () => {
        assert.throws(() => llmobs.submitFeedback({
          label: 'thumbs_up',
          metricType: 'boolean',
          value: true,
          submitter,
          spanId: '5678',
        }), { message: 'ML App name is required for sending feedback. Feedback data will not be sent.' })
        sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
      })
    })

    describe('with llmobs disabled', () => {
      before(() => {
        tracer._tracer._config.llmobs.DD_LLMOBS_ENABLED = false
      })

      after(() => {
        tracer._tracer._config.llmobs.DD_LLMOBS_ENABLED = true
      })

      it('does not submit feedback', () => {
        llmobs.submitFeedback()

        sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
      })
    })
  })

  describe('flush', () => {
    it('does not flush if llmobs is disabled', () => {
      tracer._tracer._config.llmobs.DD_LLMOBS_ENABLED = false
      llmobs.flush()

      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.flush)
      sinon.assert.notCalled(LLMObsSpanWriter.prototype.flush)
      tracer._tracer._config.llmobs.DD_LLMOBS_ENABLED = true
    })

    it('flushes the evaluation writer and span writer', () => {
      llmobs.flush()

      sinon.assert.called(LLMObsEvalMetricsWriter.prototype.flush)
      sinon.assert.called(LLMObsSpanWriter.prototype.flush)
    })

    it('logs if there was an error flushing', () => {
      LLMObsEvalMetricsWriter.prototype.flush.throws(new Error('boom'))

      llmobs.flush()
    })
  })

  describe('distributed', () => {
    it('adds the current llmobs span id and sampling decision to the injection context', () => {
      const carrier = { 'x-datadog-tags': '' }
      let parentId, span, traceId
      llmobs.trace({ kind: 'workflow', name: 'myWorkflow' }, _span => {
        span = _span
        parentId = span.context().toSpanId()
        traceId = LLMObsTagger.tagMap.get(span)['_ml_obs.trace_id']

        // simulate injection from http integration or from tracer
        // something that triggers the text_map injection
        injectCh.publish({ carrier })
      })

      const wireTraceId = BigInt(`0x${traceId}`).toString(10)

      assert.strictEqual(
        carrier['x-datadog-tags'],
        // eslint-disable-next-line @stylistic/max-len
        `_dd.p.llmobs_parent_id=${parentId},_dd.p.llmobs_ml_app=mlApp,_dd.p.llmobs_sr=1,_dd.p.llmobs_sd=1,_dd.p.llmobs_trace_id=${wireTraceId}`
      )
    })

    it('propagates the agent attribution when injecting from within an agent', () => {
      const carrier = { 'x-datadog-tags': '' }
      let agentId
      llmobs.trace({ kind: 'agent', name: 'my_agent' }, span => {
        agentId = span.context().toSpanId()
        injectCh.publish({ carrier })
      })

      const tags = carrier['x-datadog-tags']
      assert.ok(tags.includes(`_dd.p.llmobs_pagent_span_id=${agentId}`), tags)
      assert.ok(tags.includes('_dd.p.llmobs_pagent_name=my_agent'), tags)
    })

    it('inherits the agent attribution when injecting from a tool under an agent', () => {
      const carrier = { 'x-datadog-tags': '' }
      let agentId
      llmobs.trace({ kind: 'agent', name: 'my_agent' }, span => {
        agentId = span.context().toSpanId()
        llmobs.trace({ kind: 'tool', name: 'my_tool' }, () => {
          injectCh.publish({ carrier })
        })
      })

      const tags = carrier['x-datadog-tags']
      assert.ok(tags.includes(`_dd.p.llmobs_pagent_span_id=${agentId}`), tags)
      assert.ok(tags.includes('_dd.p.llmobs_pagent_name=my_agent'), tags)
    })

    it('does not propagate agent attribution when there is no agent in the chain', () => {
      const carrier = { 'x-datadog-tags': '' }
      llmobs.trace({ kind: 'workflow', name: 'my_workflow' }, () => {
        injectCh.publish({ carrier })
      })

      const tags = carrier['x-datadog-tags']
      assert.ok(!tags.includes('_dd.p.llmobs_pagent_span_id'), tags)
      assert.ok(!tags.includes('_dd.p.llmobs_pagent_name'), tags)
    })

    it('skips an unsafe agent name but still propagates the id', () => {
      const carrier = { 'x-datadog-tags': '' }
      let agentId
      llmobs.trace({ kind: 'agent', name: 'Researcher, v2' }, span => {
        agentId = span.context().toSpanId()
        injectCh.publish({ carrier })
      })

      const tags = carrier['x-datadog-tags']
      assert.ok(tags.includes(`_dd.p.llmobs_pagent_span_id=${agentId}`), tags)
      assert.ok(!tags.includes('_dd.p.llmobs_pagent_name'), tags)
    })

    it('propagates an agent name containing "=" (legal in tagset values)', () => {
      const carrier = { 'x-datadog-tags': '' }
      llmobs.trace({ kind: 'agent', name: 'model=gpt4' }, () => {
        injectCh.publish({ carrier })
      })

      const tags = carrier['x-datadog-tags']
      assert.ok(tags.includes('_dd.p.llmobs_pagent_name=model=gpt4'), tags)
    })

    it('strips stale upstream pagent entries when a local agent overrides them', () => {
      // Simulate `_injectTags` having already written upstream attribution into the carrier.
      let agentId
      const carrier = {
        'x-datadog-tags': '_dd.p.llmobs_pagent_span_id=upstream_id,_dd.p.llmobs_pagent_name=upstream_agent',
      }
      llmobs.trace({ kind: 'agent', name: 'local_agent' }, span => {
        agentId = span.context().toSpanId()
        injectCh.publish({ carrier })
      })

      const tags = carrier['x-datadog-tags']
      assert.ok(tags.includes(`_dd.p.llmobs_pagent_span_id=${agentId}`), tags)
      assert.ok(tags.includes('_dd.p.llmobs_pagent_name=local_agent'), tags)
      assert.ok(!tags.includes('upstream_id'), tags)
      assert.ok(!tags.includes('upstream_agent'), tags)
    })

    it('strips stale upstream pagent_name when local agent name is unsafe', () => {
      // Even though the upstream name was safe, the downstream should see id-only when the
      // local agent name is not wire-safe (decision: keep just the id, wipe the name).
      let agentId
      const carrier = {
        'x-datadog-tags': '_dd.p.llmobs_pagent_span_id=upstream_id,_dd.p.llmobs_pagent_name=upstream_agent',
      }
      llmobs.trace({ kind: 'agent', name: 'Researcher, v2' }, span => {
        agentId = span.context().toSpanId()
        injectCh.publish({ carrier })
      })

      const tags = carrier['x-datadog-tags']
      assert.ok(tags.includes(`_dd.p.llmobs_pagent_span_id=${agentId}`), tags)
      assert.ok(!tags.includes('_dd.p.llmobs_pagent_name'), tags)
    })

    it('drops the name when the budget is too tight for the id entry', () => {
      const originalMax = tracer._tracer._config.DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH
      const carrier = { 'x-datadog-tags': '' }

      llmobs.trace({ kind: 'agent', name: 'my_agent' }, () => {
        // First injection: measure the tags string length WITHOUT pagent entries.
        injectCh.publish({ carrier })
        const baseLength = carrier['x-datadog-tags']
          .split(',').filter(e => !e.startsWith('_dd.p.llmobs_pagent')).join(',').length

        // Second injection: budget allows the base tags but not the id entry (so name is also dropped).
        carrier['x-datadog-tags'] = ''
        tracer._tracer._config.DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH = baseLength
        injectCh.publish({ carrier })
      })
      tracer._tracer._config.DD_TRACE_X_DATADOG_TAGS_MAX_LENGTH = originalMax

      const tags = carrier['x-datadog-tags']
      assert.ok(!tags.includes('_dd.p.llmobs_pagent_span_id'), tags)
      assert.ok(!tags.includes('_dd.p.llmobs_pagent_name'), tags)
    })
  })
})
