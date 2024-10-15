'use strict'

/** Commented-out tests represent features that will be implemented in a later PR */

const { expect } = require('chai')
const Config = require('../../../src/config')

const LLMObsTagger = require('../../../src/llmobs/tagger')
const LLMObsEvalMetricsWriter = require('../../../src/llmobs/writers/evaluations')
const LLMObsAgentProxySpanWriter = require('../../../src/llmobs/writers/spans/agentProxy')

const tracerVersion = require('../../../../../package.json').version

// some functions to mock the logger globally as to not proxyquire
// this way, we can just utilize the global llmobs instance
function initializeGlobalMockLogger () {
  require.cache[require.resolve('../../../src/log')].exports = {
    debug: sinon.stub(),
    warn: sinon.stub()
  }
}

function getGlobalMockLogger () {
  return require.cache[require.resolve('../../../src/log')].exports
}

function resetGlobalMockLogger () {
  const exports = getGlobalMockLogger()
  exports.debug.resetHistory()
  exports.warn.resetHistory()
}

describe('sdk', () => {
  let LLMObsSDK
  let llmobs
  let tracer

  before(() => {
    initializeGlobalMockLogger()

    tracer = require('../../../../dd-trace')
    tracer.init({
      service: 'service',
      llmobs: {
        mlApp: 'mlApp',
        apiKey: 'test'
      }
    })
    llmobs = tracer.llmobs

    // spy on properties
    sinon.spy(console, 'warn')
    sinon.spy(console, 'debug')
    sinon.spy(llmobs._processor, 'process')
    sinon.spy(llmobs._processor, 'format')
    sinon.spy(tracer._tracer._processor, 'process')

    // stub writer functionality
    sinon.stub(LLMObsEvalMetricsWriter.prototype, 'append')
    sinon.stub(LLMObsEvalMetricsWriter.prototype, 'flush')
    sinon.stub(LLMObsAgentProxySpanWriter.prototype, 'append')
    sinon.stub(LLMObsAgentProxySpanWriter.prototype, 'flush')

    LLMObsSDK = require('../../../src/llmobs/sdk')

    // remove max listener warnings, we don't care about the writer anyways
    process.removeAllListeners('beforeExit')
  })

  afterEach(() => {
    resetGlobalMockLogger()
    llmobs._processor.process.resetHistory()
    llmobs._processor.format.resetHistory()
    tracer._tracer._processor.process.resetHistory()

    LLMObsEvalMetricsWriter.prototype.append.resetHistory()
    LLMObsEvalMetricsWriter.prototype.flush.resetHistory()

    LLMObsAgentProxySpanWriter.prototype.append.resetHistory()
    LLMObsAgentProxySpanWriter.prototype.flush.resetHistory()

    process.removeAllListeners('beforeExit')
  })

  after(() => {
    sinon.restore()
    llmobs.disable()
    delete global._ddtrace
    delete require.cache[require.resolve('../../../../dd-trace')]
  })

  describe('enabled', () => {
    for (const [value, label] of [
      [true, 'enabled'],
      [false, 'disabled']
    ]) {
      it(`returns ${value} when llmobs is ${label}`, () => {
        if (!value) sinon.stub(LLMObsSDK.prototype, '_enable')
        const enabledOrDisabledLLMObs = new LLMObsSDK(null, { disable () {} }, { llmobs: { enabled: value } })

        expect(enabledOrDisabledLLMObs.enabled).to.equal(value)
        enabledOrDisabledLLMObs.disable() // unsubscribe
        if (!value) LLMObsSDK.prototype._enable.restore()
      })
    }
  })

  describe('enable', () => {
    it('enables llmobs if it is disabled', () => {
      const config = new Config({})
      const llmobsModule = {
        enable: sinon.stub(),
        disable () {}
      }

      // do not fully enable a disabled llmobs
      sinon.stub(LLMObsSDK.prototype, '_enable')
      const disabledLLMObs = new LLMObsSDK(tracer._tracer, llmobsModule, config)
      LLMObsSDK.prototype._enable.restore()

      disabledLLMObs.enable({
        mlApp: 'mlApp'
      })

      expect(disabledLLMObs.enabled).to.be.true
      expect(disabledLLMObs._config.llmobs.mlApp).to.equal('mlApp')
      expect(disabledLLMObs._config.llmobs.apiKey).to.be.undefined
      expect(disabledLLMObs._config.llmobs.agentlessEnabled).to.be.false

      expect(disabledLLMObs._evaluationWriter).to.exist
      expect(disabledLLMObs._processor._writer).to.exist
      expect(llmobsModule.enable).to.have.been.called

      disabledLLMObs.disable() // unsubscribe
    })

    it('does not enable llmobs if it is already enabled', () => {
      llmobs.enable({})

      expect(getGlobalMockLogger().debug).to.have.been.calledWith('LLMObs is already enabled.')
    })

    it('does not enable llmobs if env var conflicts', () => {
      const config = new Config({})
      const llmobsModule = {
        enable: sinon.stub()
      }

      // do not fully enable a disabled llmobs
      sinon.stub(LLMObsSDK.prototype, '_enable')
      const disabledLLMObs = new LLMObsSDK(tracer._tracer, llmobsModule, config)
      process.env.DD_LLMOBS_ENABLED = 'false'

      disabledLLMObs.enable({})

      expect(getGlobalMockLogger().debug).to.have.been.calledWith(
        'LLMObs.enable() called when DD_LLMOBS_ENABLED is false. No action taken.'
      )

      expect(disabledLLMObs.enabled).to.be.false
      delete process.env.DD_LLMOBS_ENABLED
      disabledLLMObs.disable() // unsubscribe
      LLMObsSDK.prototype._enable.restore()
    })
  })

  describe('disable', () => {
    it('disables llmobs if it is enabled', () => {
      const llmobsModule = {
        disable: sinon.stub()
      }

      const config = new Config({
        llmobs: {}
      })

      const enabledLLMObs = new LLMObsSDK(tracer._tracer, llmobsModule, config)

      expect(enabledLLMObs.enabled).to.be.true
      enabledLLMObs.disable()

      expect(getGlobalMockLogger().debug).to.have.been.calledWith('Disabling LLMObs')
      expect(enabledLLMObs.enabled).to.be.false
      expect(enabledLLMObs._evaluationWriter).to.not.exist
      expect(enabledLLMObs._spanWriter).to.not.exist
      expect(enabledLLMObs._processor._writer).to.not.exist
      expect(llmobsModule.disable).to.have.been.called
    })

    it('does not disable llmobs if it is already disabled', () => {
      // do not fully enable a disabled llmobs
      sinon.stub(LLMObsSDK.prototype, '_enable')
      const disabledLLMObs = new LLMObsSDK(null, { disable () {} }, { llmobs: { enabled: false } })

      disabledLLMObs.disable()

      expect(getGlobalMockLogger().debug).to.have.been.calledWith('LLMObs is already disabled.')
      expect(disabledLLMObs.enabled).to.be.false

      LLMObsSDK.prototype._enable.restore()
    })
  })

  describe('tracing', () => {
    describe('startSpan', () => {
      describe('tracing behavior', () => {
        it('starts a span if llmobs is disabled but does not process it in the LLMObs span processor', () => {
          tracer._tracer._config.llmobs.enabled = false

          const span = llmobs.startSpan({ kind: 'workflow' })

          expect(() => span.finish()).to.not.throw()
          expect(llmobs._tracer._processor.process).to.have.been.called
          expect(llmobs._processor.format).to.not.have.been.called
          expect(getGlobalMockLogger().warn).to.have.been.calledWith(
            'Span started while LLMObs is disabled. Spans will not be sent to LLM Observability.'
          )
          expect(LLMObsTagger.tagMap.get(span)).to.not.exist

          tracer._tracer._config.llmobs.enabled = true
        })

        it('starts span if the kind is invalid but does not process it in the LLMObs span processor', () => {
          const span = llmobs.startSpan({ kind: 'invalid' })

          expect(getGlobalMockLogger().warn).to.have.been.calledWith(
            'Invalid span kind specified: invalid. Span will not be sent to LLM Observability.'
          )

          expect(() => span.finish()).to.not.throw()
          expect(LLMObsTagger.tagMap.get(span)).to.not.exist
          expect(llmobs._tracer._processor.process).to.have.been.called
          expect(llmobs._processor.format).to.not.have.been.called
        })
      })

      describe('parentage', () => {
        // it('starts a span with a distinct trace id', () => {
        //   const span = llmobs.startSpan('workflow')

        //   expect(span.context()._tags['_ml_obs.trace_id'])
        //     .to.exist.and.to.not.equal(span.context().toTraceId(true))
        // })

        it('sets span parentage correctly', () => {
          const span = llmobs.startSpan({ kind: 'workflow' })
          const child = llmobs.startSpan({ kind: 'task' })

          expect(LLMObsTagger.tagMap.get(child)['_ml_obs.llmobs_parent_id']).to.equal(span.context().toSpanId())
          // expect(child.context()._tags['_ml_obs.trace_id'])
          //   .to.equal(span.context()._tags['_ml_obs.trace_id'])
        })

        it('maintains llmobs parentage through apm spans', () => {
          const outerLLMObs = llmobs.startSpan({ kind: 'workflow' })
          tracer.startSpan('apmSpan', { childOf: outerLLMObs })
          const innerLLMObs = llmobs.startSpan({ kind: 'task' })

          expect(LLMObsTagger.tagMap.get(innerLLMObs)['_ml_obs.llmobs_parent_id'])
            .to.equal(outerLLMObs.context().toSpanId())
        })
      })
    })

    describe('trace', () => {
      describe('tracing behavior', () => {
        it('starts a span if llmobs is disabled but does not process it in the LLMObs span processor', () => {
          tracer._tracer._config.llmobs.enabled = false

          llmobs.trace({ kind: 'workflow', name: 'myWorkflow' }, (span, cb) => {
            expect(LLMObsTagger.tagMap.get(span)).to.not.exist
            expect(() => span.setTag('k', 'v')).to.not.throw()
            expect(() => cb()).to.not.throw()
          })

          expect(llmobs._tracer._processor.process).to.have.been.called
          expect(llmobs._processor.format).to.not.have.been.called
          expect(getGlobalMockLogger().warn).to.have.been.calledWith(
            'Span started while LLMObs is disabled. Spans will not be sent to LLM Observability.'
          )

          tracer._tracer._config.llmobs.enabled = true
        })

        it('starts span if the kind is invalid but does not process it in the LLMObs span processor', () => {
          llmobs.trace({ kind: 'invalid' }, (span, cb) => {
            expect(LLMObsTagger.tagMap.get(span)).to.not.exist
            expect(() => span.setTag('k', 'v')).to.not.throw()
            expect(() => cb()).to.not.throw()
          })

          expect(llmobs._tracer._processor.process).to.have.been.called
          expect(llmobs._processor.format).to.not.have.been.called
          expect(getGlobalMockLogger().warn).to.have.been.calledWith(
            'Invalid span kind specified: invalid. Span will not be sent to LLM Observability.'
          )
        })

        it('traces a block', () => {
          let span

          llmobs.trace({ kind: 'workflow' }, _span => {
            span = _span
            sinon.spy(span, 'finish')
          })

          expect(span.finish).to.have.been.called
        })

        it('traces a block with a callback', () => {
          let span
          let done

          llmobs.trace({ kind: 'workflow' }, (_span, _done) => {
            span = _span
            sinon.spy(span, 'finish')
            done = _done
          })

          expect(span.finish).to.not.have.been.called

          done()

          expect(span.finish).to.have.been.called
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
              expect(span.finish).to.have.been.called
              done()
            })
            .catch(done)

          expect(span.finish).to.not.have.been.called

          deferred.resolve()
        })

        it('traces a block without options', () => {
          let span

          llmobs.trace('workflow', _span => {
            span = _span
            sinon.spy(span, 'finish')
          })

          expect(span.finish).to.have.been.called
        })
      })

      describe('parentage', () => {
        // it('starts a span with a distinct trace id', () => {
        //   llmobs.trace('workflow', { name: 'test' }, span => {
        //     expect(span.context()._tags['_ml_obs.trace_id'])
        //       .to.exist.and.to.not.equal(span.context().toTraceId(true))
        //   })
        // })

        it('sets span parentage correctly', () => {
          llmobs.trace({ kind: 'workflow', name: 'test' }, outerLLMSpan => {
            llmobs.trace({ kind: 'task', name: 'test' }, innerLLMSpan => {
              expect(LLMObsTagger.tagMap.get(innerLLMSpan)['_ml_obs.llmobs_parent_id'])
                .to.equal(outerLLMSpan.context().toSpanId())
              // expect(innerLLMSpan.context()._tags['_ml_obs.trace_id'])
              //   .to.equal(outerLLMSpan.context()._tags['_ml_obs.trace_id'])
            })
          })
        })

        it('maintains llmobs parentage separately from apm spans', () => {
          llmobs.trace({ kind: 'workflow', name: 'outer-llm' }, outerLLMSpan => {
            expect(llmobs.active()).to.equal(outerLLMSpan)
            tracer.trace('apmSpan', apmSpan => {
              expect(llmobs.active()).to.equal(outerLLMSpan)
              llmobs.trace({ kind: 'workflow', name: 'inner-llm' }, innerLLMSpan => {
                expect(llmobs.active()).to.equal(innerLLMSpan)

                // llmobs span linkage
                expect(LLMObsTagger.tagMap.get(innerLLMSpan)['_ml_obs.llmobs_parent_id'])
                  .to.equal(outerLLMSpan.context().toSpanId())

                // apm span linkage
                expect(innerLLMSpan.context()._parentId.toString(10)).to.equal(apmSpan.context().toSpanId())
                expect(apmSpan.context()._parentId.toString(10)).to.equal(outerLLMSpan.context().toSpanId())
              })
            })
          })
        })

        // it('starts different traces for llmobs spans as child spans of an apm root span', () => {
        //   let apmTraceId, traceId1, traceId2
        //   tracer.trace('apmRootSpan', apmRootSpan => {
        //     apmTraceId = apmRootSpan.context().toTraceId(true)
        //     llmobs.trace('workflow', llmobsSpan1 => {
        //       traceId1 = llmobsSpan1.context()._tags['_ml_obs.trace_id']
        //     })

        //     llmobs.trace('workflow', llmobsSpan2 => {
        //       traceId2 = llmobsSpan2.context()._tags['_ml_obs.trace_id']
        //     })
        //   })

        //   expect(traceId1).to.not.equal(traceId2)
        //   expect(traceId1).to.not.equal(apmTraceId)
        //   expect(traceId2).to.not.equal(apmTraceId)
        // })

        it('maintains the llmobs parentage when error callbacks are used', () => {
          llmobs.trace({ kind: 'workflow' }, outer => {
            llmobs.trace({ kind: 'task' }, (inner, cb) => {
              expect(llmobs.active()).to.equal(inner)
              expect(LLMObsTagger.tagMap.get(inner)['_ml_obs.llmobs_parent_id']).to.equal(outer.context().toSpanId())
              cb() // finish the span
            })

            expect(llmobs.active()).to.equal(outer)

            llmobs.trace({ kind: 'task' }, (inner) => {
              expect(llmobs.active()).to.equal(inner)
              expect(LLMObsTagger.tagMap.get(inner)['_ml_obs.llmobs_parent_id']).to.equal(outer.context().toSpanId())
            })
          })
        })
      })
    })

    describe('wrap', () => {
      describe('tracing behavior', () => {
        it('starts a span if llmobs is disabled but does not process it in the LLMObs span processor', () => {
          tracer._tracer._config.llmobs.enabled = false

          const fn = llmobs.wrap({ kind: 'workflow' }, (a) => {
            expect(a).to.equal(1)
            expect(LLMObsTagger.tagMap.get(llmobs.active())).to.not.exist
          })

          expect(() => fn(1)).to.not.throw()

          expect(llmobs._tracer._processor.process).to.have.been.called
          expect(llmobs._processor.format).to.not.have.been.called
          expect(getGlobalMockLogger().warn).to.have.been.calledWith(
            'Span started while LLMObs is disabled. Spans will not be sent to LLM Observability.'
          )

          tracer._tracer._config.llmobs.enabled = true
        })

        it('starts span if the kind is invalid but does not process it in the LLMObs span processor', () => {
          const fn = llmobs.wrap({ kind: 'invalid' }, (a) => {
            expect(a).to.equal(1)
            expect(LLMObsTagger.tagMap.get(llmobs.active())).to.not.exist
          })

          // shouldn't be called until after the function is invoked
          expect(getGlobalMockLogger().warn).to.not.have.been.called

          expect(() => fn(1)).to.not.throw()

          expect(getGlobalMockLogger().warn).to.have.been.calledWith(
            'Invalid span kind specified: invalid. Span will not be sent to LLM Observability.'
          )
          expect(llmobs._tracer._processor.process).to.have.been.called
          expect(llmobs._processor.format).to.not.have.been.called
        })

        it('wraps a function', () => {
          let span
          const fn = llmobs.wrap({ kind: 'workflow' }, () => {
            span = tracer.scope().active()
            sinon.spy(span, 'finish')
          })

          fn()

          expect(span.finish).to.have.been.called
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

          expect(span.finish).to.not.have.been.called

          next()

          expect(span.finish).to.have.been.called
        })
      })

      describe('parentage', () => {
        // it('starts a span with a distinct trace id', () => {
        //   const fn = llmobs.wrap('workflow', { name: 'test' }, () => {
        //     const span = llmobs.active()
        //     expect(span.context()._tags['_ml_obs.trace_id'])
        //       .to.exist.and.to.not.equal(span.context().toTraceId(true))
        //   })

        //   fn()
        // })

        it('sets span parentage correctly', () => {
          let outerLLMSpan, innerLLMSpan

          function outer () {
            outerLLMSpan = llmobs.active()
            innerWrapped()
          }

          function inner () {
            innerLLMSpan = llmobs.active()
            expect(LLMObsTagger.tagMap.get(innerLLMSpan)['_ml_obs.llmobs_parent_id'])
              .to.equal(outerLLMSpan.context().toSpanId())
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
            outerLLMObsSpan = llmobs.active()
            expect(outerLLMObsSpan).to.equal(tracer.scope().active())

            apmWrapped()
          }
          function apm () {
            expect(llmobs.active()).to.equal(outerLLMObsSpan)
            innerWrapped()
          }
          function innerLLMObs () {
            innerLLMObsSpan = llmobs.active()
            expect(innerLLMObsSpan).to.equal(tracer.scope().active())
            expect(LLMObsTagger.tagMap.get(innerLLMObsSpan)['_ml_obs.llmobs_parent_id'])
              .to.equal(outerLLMObsSpan.context().toSpanId())
            // expect(innerLLMObsSpan.context()._tags['_ml_obs.trace_id'])
            //   .to.equal(outerLLMObsSpan.context()._tags['_ml_obs.trace_id'])
          }

          const outerWrapped = llmobs.wrap({ kind: 'workflow' }, outerLLMObs)
          const apmWrapped = tracer.wrap('workflow', apm)
          const innerWrapped = llmobs.wrap({ kind: 'workflow' }, innerLLMObs)

          outerWrapped()
        })

        // it('starts different traces for llmobs spans as child spans of an apm root span', () => {
        //   let traceId1, traceId2, apmTraceId
        //   function apm () {
        //     apmTraceId = tracer.scope().active().context().toTraceId(true)
        //     llmObsWrapped1()
        //     llmObsWrapped2()
        //   }
        //   function llmObs1 () {
        //     traceId1 = llmobs.active().context()._tags['_ml_obs.trace_id']
        //   }
        //   function llmObs2 () {
        //     traceId2 = llmobs.active().context()._tags['_ml_obs.trace_id']
        //   }

        //   const apmWrapped = tracer.wrap('workflow', apm)
        //   const llmObsWrapped1 = llmobs.wrap('workflow', llmObs1)
        //   const llmObsWrapped2 = llmobs.wrap('workflow', llmObs2)

        //   apmWrapped()

        //   expect(traceId1).to.not.equal(traceId2)
        //   expect(traceId1).to.not.equal(apmTraceId)
        //   expect(traceId2).to.not.equal(apmTraceId)
        // })

        it('maintains the llmobs parentage when callbacks are used', () => {
          let outerSpan
          function outer () {
            outerSpan = llmobs.active()
            wrappedInner1(() => {})
            expect(outerSpan).to.equal(tracer.scope().active())
            wrappedInner2()
          }

          function inner1 (cb) {
            const inner = tracer.scope().active()
            expect(llmobs.active()).to.equal(inner)
            expect(LLMObsTagger.tagMap.get(inner)['_ml_obs.llmobs_parent_id']).to.equal(outerSpan.context().toSpanId())
            cb()
          }

          function inner2 () {
            const inner = tracer.scope().active()
            expect(llmobs.active()).to.equal(inner)
            expect(LLMObsTagger.tagMap.get(inner)['_ml_obs.llmobs_parent_id']).to.equal(outerSpan.context().toSpanId())
          }

          const wrappedOuter = llmobs.wrap({ kind: 'workflow' }, outer)
          const wrappedInner1 = llmobs.wrap({ kind: 'task' }, inner1)
          const wrappedInner2 = llmobs.wrap({ kind: 'task' }, inner2)

          wrappedOuter()
        })
      })
    })
  })

  describe('annotate', () => {
    it('returns if llmobs is disabled', () => {
      tracer._tracer._config.llmobs.enabled = false
      llmobs.annotate()

      expect(getGlobalMockLogger().warn).to.have.been.calledWith(
        'Annotate called while LLMObs is disabled. Not annotating span.'
      )

      tracer._tracer._config.llmobs.enabled = true
    })

    it('returns if no arguments are provided', () => {
      llmobs.annotate()

      expect(getGlobalMockLogger().warn).to.have.been.calledWith(
        'No span provided and no active LLMObs-generated span found'
      )
    })

    it('does not annotate if there are no options given', () => {
      const span = llmobs.startSpan('llm', { name: 'test' })
      llmobs.annotate(span)

      expect(getGlobalMockLogger().warn).to.have.been.calledWith(
        'No options provided for annotation.'
      )
    })

    it('does not annotate if the provided span is not an LLMObs span', () => {
      const span = tracer.startSpan('test')

      llmobs.annotate(span, {})

      expect(getGlobalMockLogger().warn).to.have.been.calledWith(
        'Span must be an LLMObs-generated span'
      )
    })

    it('does not annotate a finished span', () => {
      llmobs.trace({ kind: 'workflow', name: 'outer' }, () => {
        let innerLLMSpan
        llmobs.trace({ kind: 'task', name: 'inner' }, _span => {
          innerLLMSpan = _span
        })

        llmobs.annotate(innerLLMSpan, {})

        expect(getGlobalMockLogger().warn).to.have.been.calledWith(
          'Cannot annotate a finished span'
        )
      })
    })

    it('does not annotate an llmobs span with an invalid kind', () => {
      // TODO this might end up being obsolete with llmobs span kind as optional
      const span = llmobs.startSpan({ kind: 'llm', name: 'test' })
      LLMObsTagger.tagMap.get(span)['_ml_obs.meta.span.kind'] = undefined // somehow this is set

      llmobs.annotate(span, {})

      expect(getGlobalMockLogger().warn).to.have.been.calledWith(
        'LLMObs span must have a span kind specified'
      )
    })

    it('annotates the current active llmobs span in an llmobs scope', () => {
      sinon.spy(llmobs._tagger, 'tagTextIO')

      llmobs.trace({ kind: 'workflow', name: 'test' }, span => {
        const inputData = {}
        llmobs.annotate({ inputData })

        expect(llmobs._tagger.tagTextIO).to.have.been.calledWith(span, inputData, undefined)
      })

      llmobs._tagger.tagTextIO.restore()
    })

    it('annotates the current active llmobs span in an apm scope', () => {
      sinon.spy(llmobs._tagger, 'tagTextIO')

      llmobs.trace({ kind: 'workflow', name: 'test' }, llmobsSpan => {
        tracer.trace('apmSpan', () => {
          const inputData = {}
          llmobs.annotate({ inputData })

          expect(llmobs._tagger.tagTextIO).to.have.been.calledWith(llmobsSpan, inputData, undefined)
        })
      })

      llmobs._tagger.tagTextIO.restore()
    })

    for (const spanKind of ['LLM', 'Embedding', 'Retrieval']) {
      const spanKindLowerCase = spanKind.toLowerCase()
      it(`annotates ${spanKindLowerCase} io for a ${spanKindLowerCase} span`, () => {
        sinon.spy(llmobs._tagger, `tag${spanKind}IO`)

        llmobs.trace({ kind: spanKindLowerCase, name: 'test' }, span => {
          const inputData = {}
          llmobs.annotate({ inputData })

          expect(llmobs._tagger[`tag${spanKind}IO`]).to.have.been.calledWith(span, inputData, undefined)
        })

        llmobs._tagger[`tag${spanKind}IO`].restore()
      })
    }

    for (const option of ['Metadata', 'Metrics', 'Tags']) {
      const optionLowerCase = option.toLowerCase()
      const method = option === 'Tags' ? 'SpanTags' : option
      it(`annotates ${optionLowerCase} if present`, () => {
        sinon.spy(llmobs._tagger, `tag${method}`)

        const span = llmobs.startSpan({ kind: 'llm', name: 'test' })
        const opt = {}
        llmobs.annotate(span, { [optionLowerCase]: opt })

        expect(llmobs._tagger[`tag${method}`]).to.have.been.calledWith(span, opt)

        llmobs._tagger[`tag${method}`].restore()
      })
    }
  })

  describe('exportSpan', () => {
    it('returns if llmobs is disabled', () => {
      tracer._tracer._config.llmobs.enabled = false
      const spanCtx = llmobs.exportSpan()

      expect(getGlobalMockLogger().warn).to.have.been.calledWith(
        'Span exported while LLMObs is disabled. Span will not be exported.'
      )
      expect(spanCtx).to.be.undefined
      tracer._tracer._config.llmobs.enabled = true
    })

    it('returns if the provided span is not an LLMObs span', () => {
      const span = tracer.startSpan('test')
      const spanCtx = llmobs.exportSpan(span)

      expect(getGlobalMockLogger().warn).to.have.been.calledWith(
        'Span must be an LLMObs-generated span'
      )
      expect(spanCtx).to.be.undefined
    })

    it('returns if there is no span provided and no active llmobs span found', () => {
      const spanCtx = llmobs.exportSpan()

      expect(getGlobalMockLogger().warn).to.have.been.calledWith(
        'No span provided and no active LLMObs-generated span found'
      )
      expect(spanCtx).to.be.undefined
    })

    it('uses the provided span', () => {
      const span = llmobs.startSpan({ kind: 'llm', name: 'test' })
      const spanCtx = llmobs.exportSpan(span)

      const traceId = span.context().toTraceId(true)
      const spanId = span.context().toSpanId()

      expect(spanCtx).to.deep.equal({ traceId, spanId })
    })

    it('uses the active span in an llmobs scope', () => {
      llmobs.trace({ kind: 'workflow', name: 'test' }, span => {
        const spanCtx = llmobs.exportSpan()

        const traceId = span.context().toTraceId(true)
        const spanId = span.context().toSpanId()

        expect(spanCtx).to.deep.equal({ traceId, spanId })
      })
    })

    it('uses the active span in an apm scope', () => {
      llmobs.trace({ kind: 'workflow', name: 'test' }, llmobsSpan => {
        tracer.trace('apmSpan', () => {
          const spanCtx = llmobs.exportSpan()

          const traceId = llmobsSpan.context().toTraceId(true)
          const spanId = llmobsSpan.context().toSpanId()

          expect(spanCtx).to.deep.equal({ traceId, spanId })
        })
      })
    })

    it('returns undefined if the provided span is not a span', () => {
      const fakeSpan = llmobs.startSpan({ kind: 'llm', name: 'test' })
      fakeSpan.context().toTraceId = undefined // something that would throw
      LLMObsTagger.tagMap.set(fakeSpan, {})
      const spanCtx = llmobs.exportSpan(fakeSpan)

      expect(spanCtx).to.be.undefined
      expect(getGlobalMockLogger().warn).to.have.been.calledWith(
        'Faild to export span. Span must be a valid Span object.'
      )
    })
  })

  describe('submitEvaluation', () => {
    let spanCtx

    beforeEach(() => {
      spanCtx = {
        traceId: '1234',
        spanId: '5678'
      }
    })

    it('does not submit an evaluation if llmobs is disabled', () => {
      tracer._tracer._config.llmobs.enabled = false
      llmobs.submitEvaluation()

      expect(getGlobalMockLogger().warn).to.have.been.calledWith(
        'LLMObs.submitEvaluation() called when LLMObs is not enabled. Evaluation metric data will not be sent.'
      )

      tracer._tracer._config.llmobs.enabled = true
    })

    it('does not submit an evaluation metric for a missing API key', () => {
      delete tracer._tracer._config.llmobs.apiKey

      const envApiKey = process.env.DD_API_KEY
      delete tracer._tracer._config.apiKey

      llmobs.submitEvaluation(spanCtx, {
        label: 'test',
        metricType: 'score',
        value: 0.6
      })
      expect(getGlobalMockLogger().warn).to.have.been.calledWith(
        'DD_API_KEY is required for sending evaluation metrics. Evaluation metric data will not be sent.\n' +
        'Ensure this configuration is set before running your application.'
      )

      tracer._tracer._config.llmobs.apiKey = 'test'
      tracer._tracer._config.apiKey = envApiKey
    })

    it('does not submit an evaluation metric for an invalid span context', () => {
      const invalid = {}

      llmobs.submitEvaluation(invalid, {})
      expect(getGlobalMockLogger().warn).to.have.been.calledWith(
        'spanId and traceId must both be specified for the given evaluation metric to be submitted.'
      )
    })

    it('does not submit an evaluation metric for a missing mlApp', () => {
      const mlApp = tracer._tracer._config.llmobs.mlApp
      delete tracer._tracer._config.llmobs.mlApp

      llmobs.submitEvaluation(spanCtx)
      expect(getGlobalMockLogger().warn).to.have.been.calledWith(
        'ML App name is required for sending evaluation metrics. Evaluation metric data will not be sent.'
      )

      tracer._tracer._config.llmobs.mlApp = mlApp
    })

    it('does not submit an evaluation metric for an invalid timestamp', () => {
      llmobs.submitEvaluation(spanCtx, {
        mlApp: 'test',
        timestampMs: 'invalid'
      })
      expect(getGlobalMockLogger().warn).to.have.been.calledWith(
        'timestampMs must be a non-negative integer. Evaluation metric data will not be sent'
      )
    })

    it('does not submit an evaluation metric for a missing label', () => {
      llmobs.submitEvaluation(spanCtx, {
        mlApp: 'test',
        timestampMs: 1234
      })
      expect(getGlobalMockLogger().warn).to.have.been.calledWith(
        'label must be the specified name of the evaluation metric'
      )
    })

    it('does not submit an evaluation metric for an invalid metric type', () => {
      llmobs.submitEvaluation(spanCtx, {
        mlApp: 'test',
        timestampMs: 1234,
        label: 'test',
        metricType: 'invalid'
      })
      expect(getGlobalMockLogger().warn).to.have.been.calledWith(
        'metricType must be one of "categorical" or "score"'
      )
    })

    it('does not submit an evaluation for a mismatched value for a categorical metric', () => {
      llmobs.submitEvaluation(spanCtx, {
        mlApp: 'test',
        timestampMs: 1234,
        label: 'test',
        metricType: 'categorical',
        value: 1
      })
      expect(getGlobalMockLogger().warn).to.have.been.calledWith(
        'value must be a string for a categorical metric.'
      )
    })

    it('does not submit an evaluation for a mismatched value for a score metric', () => {
      llmobs.submitEvaluation(spanCtx, {
        mlApp: 'test',
        timestampMs: 1234,
        label: 'test',
        metricType: 'score',
        value: 'string'
      })

      expect(getGlobalMockLogger().warn).to.have.been.calledWith(
        'value must be a number for a score metric.'
      )
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

      expect(llmobs._evaluationWriter.append.getCall(0).args[0]).to.deep.equal({
        trace_id: spanCtx.traceId,
        span_id: spanCtx.spanId,
        ml_app: 'test',
        timestamp_ms: 1234,
        label: 'test',
        metric_type: 'score',
        score_value: 0.6,
        tags: [`dd-trace.version:${tracerVersion}`, 'ml_app:test', 'host:localhost']
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

      expect(llmobs._evaluationWriter.append.getCall(0).args[0]).to.have.property('categorical_value', 'foo')
    })

    it('defaults to the current time if no timestamp is provided', () => {
      sinon.stub(Date, 'now').returns(1234)
      llmobs.submitEvaluation(spanCtx, {
        mlApp: 'test',
        label: 'test',
        metricType: 'score',
        value: 0.6
      })

      expect(llmobs._evaluationWriter.append.getCall(0).args[0]).to.have.property('timestamp_ms', 1234)
      Date.now.restore()
    })
  })

  describe('flush', () => {
    it('does not flush if llmobs is disabled', () => {
      tracer._tracer._config.llmobs.enabled = false
      llmobs.flush()

      expect(getGlobalMockLogger().warn).to.have.been.calledWith(
        'Flushing when LLMObs is disabled. No spans or evaluation metrics will be sent'
      )
      tracer._tracer._config.llmobs.enabled = true
    })

    it('flushes the evaluation writer and span writer', () => {
      llmobs.flush()

      expect(llmobs._evaluationWriter.flush).to.have.been.called
      expect(llmobs._processor._writer.flush).to.have.been.called
    })

    it('logs if there was an error flushing', () => {
      llmobs._evaluationWriter.flush.throws(new Error('boom'))

      llmobs.flush()

      expect(getGlobalMockLogger().warn).to.have.been.calledWith(
        'Failed to flush LLMObs spans and evaluation metrics'
      )

      llmobs._evaluationWriter.flush.resetBehavior()
    })
  })
})
