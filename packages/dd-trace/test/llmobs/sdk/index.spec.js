'use strict'

const assert = require('node:assert')

const { expect } = require('chai')
const { channel } = require('dc-polyfill')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const LLMObsSpanProcessor = require('../../../src/llmobs/span_processor')
const LLMObsTagger = require('../../../src/llmobs/tagger')
const LLMObsEvalMetricsWriter = require('../../../src/llmobs/writers/evaluations')
const LLMObsSpanWriter = require('../../../src/llmobs/writers/spans')
const { getConfigFresh } = require('../../helpers/config')
const tracerVersion = require('../../../../../package.json').version

const agent = require('../../plugins/agent')
const injectCh = channel('dd-trace:span:inject')

describe('sdk', () => {
  let LLMObsSDK
  let llmobs
  let llmobsModule
  let tracer
  let clock

  before(() => {
    tracer = require('../../../../dd-trace')
    tracer.init({
      service: 'service',
      llmobs: {
        mlApp: 'mlApp',
        agentlessEnabled: false
      }
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
    process.removeAllListeners('beforeExit')

    clock = sinon.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
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

    process.removeAllListeners('beforeExit')
  })

  after(() => {
    sinon.restore()
    llmobsModule.disable()
    agent.wipe() // clear the require cache
  })

  describe('enabled', () => {
    for (const [value, label] of [
      [true, 'enabled'],
      [false, 'disabled']
    ]) {
      it(`returns ${value} when llmobs is ${label}`, () => {
        const enabledOrDisabledLLMObs = new LLMObsSDK(null, { disable () {} }, { llmobs: { enabled: value } })

        assert.strictEqual(enabledOrDisabledLLMObs.enabled, value)
        enabledOrDisabledLLMObs.disable() // unsubscribe
      })
    }
  })

  describe('enable', () => {
    it('enables llmobs if it is disabled', () => {
      const config = getConfigFresh({})
      const llmobsModule = {
        enable: sinon.stub(),
        disable () {}
      }

      // do not fully enable a disabled llmobs
      const disabledLLMObs = new LLMObsSDK(tracer._tracer, llmobsModule, config)

      disabledLLMObs.enable({
        mlApp: 'mlApp'
      })

      assert.strictEqual(disabledLLMObs.enabled, true)
      assert.strictEqual(disabledLLMObs._config.llmobs.mlApp, 'mlApp')
      assert.strictEqual(disabledLLMObs._config.llmobs.agentlessEnabled, undefined)

      sinon.assert.called(llmobsModule.enable)

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
        enable: sinon.stub()
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
        disable: sinon.stub()
      }

      const config = getConfigFresh({
        llmobs: {}
      })

      const enabledLLMObs = new LLMObsSDK(tracer._tracer, llmobsModule, config)

      assert.strictEqual(enabledLLMObs.enabled, true)
      enabledLLMObs.disable()

      assert.strictEqual(enabledLLMObs.enabled, false)
      sinon.assert.called(llmobsModule.disable)
    })

    it('does not disable llmobs if it is already disabled', () => {
      // do not fully enable a disabled llmobs
      const disabledLLMObs = new LLMObsSDK(null, { disable () {} }, { llmobs: { enabled: false } })
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
          tracer._tracer._config.llmobs.enabled = false

          llmobs.trace({ kind: 'workflow', name: 'myWorkflow' }, (span, cb) => {
            assert.ok(LLMObsTagger.tagMap.get(span) == null)
            assert.doesNotThrow(() => span.setTag('k', 'v'))
            assert.doesNotThrow(() => cb())
          })

          sinon.assert.called(llmobs._tracer._processor.process)
          sinon.assert.notCalled(LLMObsSpanProcessor.prototype.format)

          tracer._tracer._config.llmobs.enabled = true
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
        // TODO: need to implement custom trace IDs
        it.skip('starts a span with a distinct trace id', () => {
          llmobs.trace({ kind: 'workflow', name: 'test' }, span => {
            const traceId = LLMObsTagger.tagMap.get(span)['_ml_obs.trace_id']
            assert.ok(traceId != null)
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
              // TODO: need to implement custom trace IDs
              // expect(innerLLMSpan.context()._tags['_ml_obs.trace_id'])
              //   .to.equal(outerLLMSpan.context()._tags['_ml_obs.trace_id'])
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

        // TODO: need to implement custom trace IDs
        it.skip('starts different traces for llmobs spans as child spans of an apm root span', () => {
          let apmTraceId, traceId1, traceId2
          tracer.trace('apmRootSpan', apmRootSpan => {
            apmTraceId = apmRootSpan.context().toTraceId(true)
            llmobs.trace('workflow', llmobsSpan1 => {
              traceId1 = llmobsSpan1.context()._tags['_ml_obs.trace_id']
            })

            llmobs.trace('workflow', llmobsSpan2 => {
              traceId2 = llmobsSpan2.context()._tags['_ml_obs.trace_id']
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
          modelProvider: 'modelProvider'
        }, (_span) => {
          span = _span
        })

        assert.deepStrictEqual(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.meta.span.kind': 'workflow',
          '_ml_obs.meta.ml_app': 'override',
          '_ml_obs.meta.model_name': 'modelName',
          '_ml_obs.meta.model_provider': 'modelProvider',
          '_ml_obs.session_id': 'sessionId',
          '_ml_obs.llmobs_parent_id': 'undefined'
        })
      })
    })

    describe('wrap', () => {
      describe('tracing behavior', () => {
        it('starts a span if llmobs is disabled but does not process it in the LLMObs span processor', () => {
          tracer._tracer._config.llmobs.enabled = false

          const fn = llmobs.wrap({ kind: 'workflow' }, (a) => {
            assert.strictEqual(a, 1)
            assert.ok(LLMObsTagger.tagMap.get(llmobs._active()) == null)
          })

          assert.doesNotThrow(() => fn(1))

          sinon.assert.called(llmobs._tracer._processor.process)
          sinon.assert.notCalled(LLMObsSpanProcessor.prototype.format)

          tracer._tracer._config.llmobs.enabled = true
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

          assert.deepStrictEqual(LLMObsTagger.tagMap.get(span), {
            '_ml_obs.meta.span.kind': 'llm',
            '_ml_obs.meta.ml_app': 'mlApp',
            '_ml_obs.llmobs_parent_id': 'undefined'
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

          assert.deepStrictEqual(LLMObsTagger.tagMap.get(span), {
            '_ml_obs.meta.span.kind': 'embedding',
            '_ml_obs.meta.ml_app': 'mlApp',
            '_ml_obs.llmobs_parent_id': 'undefined',
            '_ml_obs.meta.output.value': 'output'
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

          assert.deepStrictEqual(LLMObsTagger.tagMap.get(span), {
            '_ml_obs.meta.span.kind': 'retrieval',
            '_ml_obs.meta.ml_app': 'mlApp',
            '_ml_obs.llmobs_parent_id': 'undefined',
            '_ml_obs.meta.input.value': 'input'
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
              outputData: 'foo'
            })
            return ''
          }

          const wrappedMyWorkflow = llmobs.wrap({ kind: 'workflow' }, myWorkflow)
          wrappedMyWorkflow(circular)

          assert.deepStrictEqual(LLMObsTagger.tagMap.get(span), {
            '_ml_obs.meta.span.kind': 'workflow',
            '_ml_obs.meta.ml_app': 'mlApp',
            '_ml_obs.llmobs_parent_id': 'undefined',
            '_ml_obs.meta.input.value': 'circular',
            '_ml_obs.meta.output.value': 'foo'
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

          assert.deepStrictEqual(LLMObsTagger.tagMap.get(span), {
            '_ml_obs.meta.span.kind': 'task',
            '_ml_obs.meta.ml_app': 'mlApp',
            '_ml_obs.llmobs_parent_id': 'undefined',
            '_ml_obs.meta.input.value': JSON.stringify({ foo: 'foo', bar: 'bar' })
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
              assert.deepStrictEqual(LLMObsTagger.tagMap.get(span), {
                '_ml_obs.meta.span.kind': 'task',
                '_ml_obs.meta.ml_app': 'mlApp',
                '_ml_obs.llmobs_parent_id': 'undefined',
                '_ml_obs.meta.input.value': JSON.stringify({ foo: 'foo', bar: 'bar' })
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
            assert.ok(err == null)
            assert.strictEqual(res, 'output')
          })

          clock.tick(1000)

          assert.deepStrictEqual(LLMObsTagger.tagMap.get(span), {
            '_ml_obs.meta.span.kind': 'workflow',
            '_ml_obs.meta.ml_app': 'mlApp',
            '_ml_obs.llmobs_parent_id': 'undefined',
            '_ml_obs.meta.input.value': JSON.stringify({ input: 'input' }),
            '_ml_obs.meta.output.value': 'output'
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
            assert.ok(err != null)
            assert.strictEqual(res, 'output')
          })

          clock.tick(1000)

          assert.deepStrictEqual(LLMObsTagger.tagMap.get(span), {
            '_ml_obs.meta.span.kind': 'workflow',
            '_ml_obs.meta.ml_app': 'mlApp',
            '_ml_obs.llmobs_parent_id': 'undefined',
            '_ml_obs.meta.input.value': JSON.stringify({ input: 'input' }),
            '_ml_obs.meta.output.value': 'output'
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

          assert.deepStrictEqual(LLMObsTagger.tagMap.get(span), {
            '_ml_obs.meta.span.kind': 'workflow',
            '_ml_obs.meta.ml_app': 'mlApp',
            '_ml_obs.llmobs_parent_id': 'undefined',
            '_ml_obs.meta.input.value': JSON.stringify({ input: 'input' }),
            '_ml_obs.meta.output.value': 'output'
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
                assert.ok(err == null)
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
        // TODO: need to implement custom trace IDs
        it.skip('starts a span with a distinct trace id', () => {
          const fn = llmobs.wrap('workflow', { name: 'test' }, () => {
            const span = llmobs._active()

            const traceId = span.context()._tags['_ml_obs.trace_id']
            assert.ok(traceId != null)
            assert.notStrictEqual(traceId, span.context().toTraceId(true))
          })

          fn()
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
            // TODO: need to implement custom trace IDs
            // expect(innerLLMSpan.context()._tags['_ml_obs.trace_id'])
            //   .to.equal(outerLLMSpan.context()._tags['_ml_obs.trace_id'])
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
            // TODO: need to implement custom trace IDs
            // expect(innerLLMObsSpan.context()._tags['_ml_obs.trace_id'])
            //   .to.equal(outerLLMObsSpan.context()._tags['_ml_obs.trace_id'])
          }

          const outerWrapped = llmobs.wrap({ kind: 'workflow' }, outerLLMObs)
          const apmWrapped = tracer.wrap('workflow', apm)
          const innerWrapped = llmobs.wrap({ kind: 'workflow' }, innerLLMObs)

          outerWrapped()
        })

        // TODO: need to implement custom trace IDs
        it.skip('starts different traces for llmobs spans as child spans of an apm root span', () => {
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
          modelProvider: 'modelProvider'
        }, () => {
          span = llmobs._active()
        })

        fn()

        assert.deepStrictEqual(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.meta.span.kind': 'workflow',
          '_ml_obs.meta.ml_app': 'override',
          '_ml_obs.meta.model_name': 'modelName',
          '_ml_obs.meta.model_provider': 'modelProvider',
          '_ml_obs.session_id': 'sessionId',
          '_ml_obs.llmobs_parent_id': 'undefined'
        })
      })
    })
  })

  describe('annotate', () => {
    it('returns if llmobs is disabled', () => {
      tracer._tracer._config.llmobs.enabled = false
      sinon.spy(llmobs, '_active')
      llmobs.annotate()

      sinon.assert.notCalled(llmobs._active)
      llmobs._active.restore()

      tracer._tracer._config.llmobs.enabled = true
    })

    it('throws if no arguments are provided', () => {
      assert.throws(() => llmobs.annotate())
    })

    it('throws if there are no options given', () => {
      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        assert.throws(() => llmobs.annotate(span))

        // span should still exist in the registry, just with no annotations
        assert.deepStrictEqual(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined'
        })
      })
    })

    it('throws if the provided span is not an LLMObs span', () => {
      tracer.trace('test', span => {
        assert.throws(() => llmobs.annotate(span, {}))

        // no span in registry, should not throw
        assert.ok(LLMObsTagger.tagMap.get(span) == null)
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

        assert.deepStrictEqual(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.meta.input.messages': inputData,
          '_ml_obs.meta.output.messages': outputData
        })
      })
    })

    it('annotates embedding io for an embedding span', () => {
      const inputData = [{ text: 'input text' }]
      const outputData = 'documents embedded'

      llmobs.trace({ kind: 'embedding', name: 'test' }, span => {
        llmobs.annotate({ inputData, outputData })

        assert.deepStrictEqual(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.meta.span.kind': 'embedding',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.meta.input.documents': inputData,
          '_ml_obs.meta.output.value': outputData
        })
      })
    })

    it('annotates retrieval io for a retrieval span', () => {
      const inputData = 'input text'
      const outputData = [{ text: 'output text' }]

      llmobs.trace({ kind: 'retrieval', name: 'test' }, span => {
        llmobs.annotate({ inputData, outputData })

        assert.deepStrictEqual(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.meta.span.kind': 'retrieval',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.meta.input.value': inputData,
          '_ml_obs.meta.output.documents': outputData
        })
      })
    })

    it('annotates metadata if present', () => {
      const metadata = { response_type: 'json' }

      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        llmobs.annotate({ metadata })

        assert.deepStrictEqual(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.meta.metadata': metadata
        })
      })
    })

    it('annotates metrics if present', () => {
      const metrics = { score: 0.6 }

      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        llmobs.annotate({ metrics })

        assert.deepStrictEqual(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.metrics': metrics
        })
      })
    })

    it('annotates tags if present', () => {
      const tags = { 'custom.tag': 'value' }

      llmobs.trace({ kind: 'llm', name: 'test' }, span => {
        llmobs.annotate({ tags })

        assert.deepStrictEqual(LLMObsTagger.tagMap.get(span), {
          '_ml_obs.meta.span.kind': 'llm',
          '_ml_obs.meta.ml_app': 'mlApp',
          '_ml_obs.llmobs_parent_id': 'undefined',
          '_ml_obs.tags': tags
        })
      })
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

        const traceId = span.context().toTraceId(true)
        const spanId = span.context().toSpanId()

        assert.deepStrictEqual(spanCtx, { traceId, spanId })
      })
    })

    it('uses the active span in an llmobs scope', () => {
      llmobs.trace({ kind: 'workflow', name: 'test' }, span => {
        const spanCtx = llmobs.exportSpan()

        const traceId = span.context().toTraceId(true)
        const spanId = span.context().toSpanId()

        assert.deepStrictEqual(spanCtx, { traceId, spanId })
      })
    })

    it('uses the active span in an apm scope', () => {
      llmobs.trace({ kind: 'workflow', name: 'test' }, llmobsSpan => {
        tracer.trace('apmSpan', () => {
          const spanCtx = llmobs.exportSpan()

          const traceId = llmobsSpan.context().toTraceId(true)
          const spanId = llmobsSpan.context().toSpanId()

          assert.deepStrictEqual(spanCtx, { traceId, spanId })
        })
      })
    })

    it('returns undefined if the provided span is not a span', () => {
      llmobs.trace({ kind: 'workflow', name: 'test' }, fakeSpan => {
        fakeSpan.context().toTraceId = undefined // something that would throw
        LLMObsTagger.tagMap.set(fakeSpan, {})
        const spanCtx = llmobs.exportSpan(fakeSpan)

        assert.strictEqual(spanCtx, undefined)
      })
    })
  })

  describe('submitEvaluation', () => {
    let spanCtx
    let originalApiKey

    before(() => {
      originalApiKey = tracer._tracer._config.apiKey
      tracer._tracer._config.apiKey = 'test'
    })

    beforeEach(() => {
      spanCtx = {
        traceId: '1234',
        spanId: '5678'
      }
    })

    after(() => {
      tracer._tracer._config.apiKey = originalApiKey
    })

    it('does not submit an evaluation if llmobs is disabled', () => {
      tracer._tracer._config.llmobs.enabled = false
      llmobs.submitEvaluation()

      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)

      tracer._tracer._config.llmobs.enabled = true
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
          timestampMs: 'invalid'
        })
      })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('throws for a missing label', () => {
      assert.throws(() => {
        llmobs.submitEvaluation(spanCtx, {
          mlApp: 'test',
          timestampMs: 1234
        })
      })
      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.append)
    })

    it('throws for an invalid metric type', () => {
      assert.throws(() => {
        llmobs.submitEvaluation(spanCtx, {
          mlApp: 'test',
          timestampMs: 1234,
          label: 'test',
          metricType: 'invalid'
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
          value: 1
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
          value: 'string'
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
          host: 'localhost'
        }
      })

      assert.deepStrictEqual(LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0], {
        trace_id: spanCtx.traceId,
        span_id: spanCtx.spanId,
        ml_app: 'test',
        timestamp_ms: 1234,
        label: 'test',
        metric_type: 'score',
        score_value: 0.6,
        tags: [`ddtrace.version:${tracerVersion}`, 'ml_app:test', 'host:localhost']
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
          host: 'localhost'
        }
      })

      assert.ok('categorical_value' in LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0]);
  assert.strictEqual(LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0]['categorical_value'], 'foo')
    })

    it('defaults to the current time if no timestamp is provided', () => {
      sinon.stub(Date, 'now').returns(1234)
      llmobs.submitEvaluation(spanCtx, {
        mlApp: 'test',
        label: 'test',
        metricType: 'score',
        value: 0.6
      })

      assert.ok('timestamp_ms' in LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0]);
  assert.strictEqual(LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0]['timestamp_ms'], 1234)
      Date.now.restore()
    })

    it('submits a boolean evaluation metric', () => {
      llmobs.submitEvaluation(spanCtx, {
        label: 'has_toxicity',
        metricType: 'boolean',
        value: true,
        timestampMs: 1234
      })

      const evalMetric = LLMObsEvalMetricsWriter.prototype.append.getCall(0).args[0]

      assert.deepStrictEqual(evalMetric, {
        span_id: '5678',
        trace_id: '1234',
        label: 'has_toxicity',
        metric_type: 'boolean',
        ml_app: 'mlApp',
        boolean_value: true,
        timestamp_ms: 1234,
        tags: [`ddtrace.version:${tracerVersion}`, 'ml_app:mlApp']
      })
    })

    it('throws an error when submitting a non-boolean boolean evaluation metric', () => {
      assert.throws(() => llmobs.submitEvaluation(spanCtx, {
        label: 'has_toxicity',
        metricType: 'boolean',
        value: 'it is super toxic!'
      }), { message: 'value must be a boolean for a boolean metric' })
    })
  })

  describe('flush', () => {
    it('does not flush if llmobs is disabled', () => {
      tracer._tracer._config.llmobs.enabled = false
      llmobs.flush()

      sinon.assert.notCalled(LLMObsEvalMetricsWriter.prototype.flush)
      sinon.assert.notCalled(LLMObsSpanWriter.prototype.flush)
      tracer._tracer._config.llmobs.enabled = true
    })

    it('flushes the evaluation writer and span writer', () => {
      llmobs.flush()

      sinon.assert.called(LLMObsEvalMetricsWriter.prototype.flush)
      sinon.assert.called(LLMObsSpanWriter.prototype.flush)
    })

    it('logs if there was an error flushing', () => {
      LLMObsEvalMetricsWriter.prototype.flush.throws(new Error('boom'))

      assert.doesNotThrow(() => llmobs.flush())
    })
  })

  describe('distributed', () => {
    it('adds the current llmobs span id to the injection context', () => {
      const carrier = { 'x-datadog-tags': '' }
      let parentId, span
      llmobs.trace({ kind: 'workflow', name: 'myWorkflow' }, _span => {
        span = _span
        parentId = span.context().toSpanId()

        // simulate injection from http integration or from tracer
        // something that triggers the text_map injection
        injectCh.publish({ carrier })
      })

      assert.strictEqual(carrier['x-datadog-tags'], `,_dd.p.llmobs_parent_id=${parentId},_dd.p.llmobs_ml_app=mlApp`)
    })
  })
})
