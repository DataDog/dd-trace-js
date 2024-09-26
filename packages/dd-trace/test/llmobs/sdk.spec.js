'use strict'

const proxyquire = require('proxyquire')
const { expect } = require('chai')
const Config = require('../../src/config')

describe('sdk', () => {
  let LLMObsSDK
  let llmobs
  let logger
  let Tracer
  let tracer

  beforeEach(() => {
    logger = {
      debug: sinon.stub(),
      warn: sinon.stub()
    }

    LLMObsSDK = proxyquire('../../src/llmobs/sdk', {
      '../log': logger,
      '../../../../package.json': { version: 'x.y.z' }
    })

    Tracer = proxyquire('../../src/proxy', {
      './llmobs/sdk': LLMObsSDK
    })

    tracer = new Tracer().init({
      service: 'service',
      llmobs: {
        mlApp: 'mlApp',
        apiKey: 'test'
      }
    })
    tracer._tracer._exporter.setUrl = sinon.stub()
    tracer._tracer._exporter.export = sinon.stub()
    tracer._tracer._prioritySampler.configure = sinon.stub()

    // for checking if llmobs spans are sent or not
    sinon.spy(tracer._tracer._processor, 'process')
    sinon.spy(tracer._tracer._processor._llmobs, '_process')
    tracer._tracer._processor._llmobs._writer.append = sinon.stub()

    // tracer initializes the llmobs writer with this listener,
    // even though the method that calls it (process) gets stubbed
    // remove all beforeExit listeners
    process.removeAllListeners('beforeExit')

    llmobs = tracer.llmobs

    sinon.stub(llmobs._evaluationWriter, 'flush')
    sinon.stub(llmobs._evaluationWriter, 'append')
    sinon.stub(llmobs._tracer._processor._llmobs._writer, 'flush')
  })

  describe('constructor', () => {
    it('starts the evaluations writer when enabled', () => {
      llmobs = new LLMObsSDK(null, null, { llmobs: { enabled: true } })

      expect(llmobs._evaluationWriter).to.exist
    })

    it('does not start the evaluations writer when disabled', () => {
      llmobs = new LLMObsSDK(null, null, { llmobs: { enabled: false } })

      expect(llmobs._evaluationWriter).to.not.exist
    })
  })

  describe('enabled', () => {
    for (const [value, label] of [
      [true, 'enabled'],
      [false, 'disabled']
    ]) {
      it(`returns ${value} when llmobs is ${label}`, () => {
        llmobs = new LLMObsSDK(null, null, { llmobs: { enabled: value } })

        expect(llmobs.enabled).to.equal(value)
      })
    }
  })

  describe('enable', () => {
    it('enables llmobs if it is disabled', () => {
      const config = new Config({})
      const llmobsModule = {
        enable: sinon.stub()
      }
      llmobs = new LLMObsSDK(tracer._tracer, llmobsModule, config)

      llmobs.enable({
        mlApp: 'mlApp'
      })

      expect(llmobs.enabled).to.be.true
      expect(llmobs._config.llmobs.mlApp).to.equal('mlApp')
      expect(llmobs._config.llmobs.apiKey).to.be.undefined
      expect(llmobs._config.llmobs.agentlessEnabled).to.be.false

      expect(llmobs._evaluationWriter).to.exist
      expect(llmobs._tracer._processor._llmobs._writer).to.exist
      expect(llmobsModule.enable).to.have.been.called
    })

    it('does not enable llmobs if it is already enabled', () => {
      llmobs.enable({})

      expect(logger.debug).to.have.been.calledWith('LLMObs is already enabled.')
    })

    it('does not enable llmobs if env var conflicts', () => {
      const config = new Config({})
      const llmobsModule = {
        enable: sinon.stub()
      }

      llmobs = new LLMObsSDK(tracer._tracer, llmobsModule, config)
      process.env.DD_LLMOBS_ENABLED = 'false'

      llmobs.enable({})

      expect(logger.debug).to.have.been.calledWith(
        'LLMObs.enable() called when DD_LLMOBS_ENABLED is false. No action taken.'
      )

      expect(llmobs.enabled).to.be.false
      delete process.env.DD_LLMOBS_ENABLED
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

      llmobs = new LLMObsSDK(tracer._tracer, llmobsModule, config)

      expect(llmobs.enabled).to.be.true
      llmobs.disable()

      expect(logger.debug).to.have.been.calledWith('Disabling LLMObs')
      expect(llmobs.enabled).to.be.false
      expect(llmobs._evaluationWriter).to.not.exist
      expect(llmobs._tracer._processor._llmobs._writer).to.not.exist
      expect(llmobsModule.disable).to.have.been.called
    })

    it('does not disable llmobs if it is already disabled', () => {
      llmobs = new LLMObsSDK(null, null, { llmobs: { enabled: false } })

      llmobs.disable()

      expect(logger.debug).to.have.been.calledWith('LLMObs is already disabled.')
      expect(llmobs.enabled).to.be.false
    })
  })

  describe('tracing', () => {
    describe('startSpan', () => {
      describe('tracing behavior', () => {
        it('starts a span if llmobs is disabled but does not process it in the LLMObs span processor', () => {
          tracer._tracer._config.llmobs.enabled = false
          sinon.spy(llmobs._tagger, 'setLLMObsSpanTags')

          const span = llmobs.startSpan('workflow')

          expect(() => span.finish()).to.not.throw()
          expect(llmobs._tracer._processor.process).to.have.been.called
          expect(llmobs._tracer._processor._llmobs._process).to.not.have.been.called
          expect(logger.warn).to.have.been.calledWith(
            'Span started while LLMObs is disabled. Spans will not be sent to LLM Observability.'
          )
        })

        it('starts span if the kind is invalid but does not process it in the LLMObs span processor', () => {
          sinon.spy(llmobs._tagger, 'setLLMObsSpanTags')
          const span = llmobs.startSpan('invalid')

          expect(logger.warn).to.have.been.calledWith(
            'Invalid span kind specified: invalid. Span will not be sent to LLM Observability.'
          )

          expect(() => span.finish()).to.not.throw()
          expect(llmobs._tagger.setLLMObsSpanTags).to.have.been.called
          expect(llmobs._tracer._processor.process).to.have.been.called
          expect(llmobs._tracer._processor._llmobs._process).to.not.have.been.called
        })
      })

      describe('parentage', () => {
        // it('starts a span with a distinct trace id', () => {
        //   const span = llmobs.startSpan('workflow')

        //   expect(span.context()._tags['_ml_obs.trace_id'])
        //     .to.exist.and.to.not.equal(span.context().toTraceId(true))
        // })

        it('sets span parentage correctly', () => {
          const span = llmobs.startSpan('workflow')
          const child = llmobs.startSpan('task')

          expect(child.context()._tags['_ml_obs.llmobs_parent_id']).to.equal(span.context().toSpanId())
          // expect(child.context()._tags['_ml_obs.trace_id'])
          //   .to.equal(span.context()._tags['_ml_obs.trace_id'])
        })

        it('maintains llmobs parentage through apm spans', () => {
          const outerLLMObs = llmobs.startSpan('workflow')
          tracer.startSpan('apmSpan', { childOf: outerLLMObs })
          const innerLLMObs = llmobs.startSpan('task')

          expect(innerLLMObs.context()._tags['_ml_obs.llmobs_parent_id']).to.equal(outerLLMObs.context().toSpanId())
        })
      })
    })

    describe('trace', () => {
      describe('tracing behavior', () => {
        it('starts a span if llmobs is disabled but does not process it in the LLMObs span processor', () => {
          tracer._tracer._config.llmobs.enabled = false
          sinon.spy(llmobs._tagger, 'setLLMObsSpanTags')

          llmobs.trace('workflow', {}, (span, cb) => {
            expect(() => span.setTag('k', 'v')).to.not.throw()
            expect(() => cb()).to.not.throw()
          })

          expect(llmobs._tracer._processor.process).to.have.been.called
          expect(llmobs._tracer._processor._llmobs._process).to.not.have.been.called
          expect(logger.warn).to.have.been.calledWith(
            'Span started while LLMObs is disabled. Spans will not be sent to LLM Observability.'
          )
        })

        it('starts span if the kind is invalid but does not process it in the LLMObs span processor', () => {
          sinon.spy(llmobs._tagger, 'setLLMObsSpanTags')
          llmobs.trace('invalid', {}, (span, cb) => {
            expect(() => span.setTag('k', 'v')).to.not.throw()
            expect(() => cb()).to.not.throw()
          })

          expect(llmobs._tagger.setLLMObsSpanTags).to.have.been.called
          expect(llmobs._tracer._processor.process).to.have.been.called
          expect(llmobs._tracer._processor._llmobs._process).to.not.have.been.called
          expect(logger.warn).to.have.been.calledWith(
            'Invalid span kind specified: invalid. Span will not be sent to LLM Observability.'
          )
        })

        it('traces a block', () => {
          let span

          llmobs.trace('workflow', {}, _span => {
            span = _span
            sinon.spy(span, 'finish')
          })

          expect(span.finish).to.have.been.called
        })

        it('traces a block with a callback', () => {
          let span
          let done

          llmobs.trace('workflow', {}, (_span, _done) => {
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
            .trace('workflow', {}, _span => {
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
          llmobs.trace('workflow', { name: 'test' }, outerLLMSpan => {
            llmobs.trace('task', { name: 'test' }, innerLLMSpan => {
              expect(innerLLMSpan.context()._tags['_ml_obs.llmobs_parent_id'])
                .to.equal(outerLLMSpan.context().toSpanId())
              // expect(innerLLMSpan.context()._tags['_ml_obs.trace_id'])
              //   .to.equal(outerLLMSpan.context()._tags['_ml_obs.trace_id'])
            })
          })
        })

        it('maintains llmobs parentage separately from apm spans', () => {
          llmobs.trace('workflow', { name: 'outer-llm' }, outerLLMSpan => {
            expect(llmobs._active()).to.equal(outerLLMSpan)
            tracer.trace('apmSpan', apmSpan => {
              expect(llmobs._active()).to.equal(outerLLMSpan)
              llmobs.trace('workflow', { name: 'inner-llm' }, innerLLMSpan => {
                expect(llmobs._active()).to.equal(innerLLMSpan)

                // llmobs span linkage
                expect(innerLLMSpan.context()._tags['_ml_obs.llmobs_parent_id'])
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
          llmobs.trace('workflow', outer => {
            llmobs.trace('task', (inner, cb) => {
              expect(llmobs._active()).to.equal(inner)
              expect(inner.context()._tags['_ml_obs.llmobs_parent_id']).to.equal(outer.context().toSpanId())
              cb() // finish the span
            })

            expect(llmobs._active()).to.equal(outer)

            llmobs.trace('task', (inner) => {
              expect(llmobs._active()).to.equal(inner)
              expect(inner.context()._tags['_ml_obs.llmobs_parent_id']).to.equal(outer.context().toSpanId())
            })
          })
        })
      })
    })

    describe('wrap', () => {
      describe('tracing behavior', () => {
        it('starts a span if llmobs is disabled but does not process it in the LLMObs span processor', () => {
          tracer._tracer._config.llmobs.enabled = false
          sinon.spy(llmobs._tagger, 'setLLMObsSpanTags')

          const fn = llmobs.wrap('workflow', {}, (a) => {
            expect(a).to.equal(1)
          })

          expect(() => fn(1)).to.not.throw()

          expect(llmobs._tracer._processor.process).to.have.been.called
          expect(llmobs._tracer._processor._llmobs._process).to.not.have.been.called
          expect(logger.warn).to.have.been.calledWith(
            'Span started while LLMObs is disabled. Spans will not be sent to LLM Observability.'
          )
        })

        it('starts span if the kind is invalid but does not process it in the LLMObs span processor', () => {
          sinon.spy(llmobs._tagger, 'setLLMObsSpanTags')
          const fn = llmobs.wrap('invalid', {}, (a) => {
            expect(a).to.equal(1)
          })

          expect(logger.warn).to.not.have.been.called // shouldn't be called until after the function is invoked

          expect(() => fn(1)).to.not.throw()

          expect(logger.warn).to.have.been.calledWith(
            'Invalid span kind specified: invalid. Span will not be sent to LLM Observability.'
          )
          expect(llmobs._tagger.setLLMObsSpanTags).to.have.been.called
          expect(llmobs._tracer._processor.process).to.have.been.called
          expect(llmobs._tracer._processor._llmobs._process).to.not.have.been.called
        })

        it('wraps a function', () => {
          let span
          const fn = llmobs.wrap('workflow', {}, () => {
            span = tracer.scope().active()
            sinon.spy(span, 'finish')
          })

          fn()

          expect(span.finish).to.have.been.called
        })

        it('wraps a function with a callback', () => {
          let span
          let next

          const fn = llmobs.wrap('workflow', {}, (_next) => {
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
        //     const span = llmobs._active()
        //     expect(span.context()._tags['_ml_obs.trace_id'])
        //       .to.exist.and.to.not.equal(span.context().toTraceId(true))
        //   })

        //   fn()
        // })

        it('sets span parentage correctly', () => {
          let outerLLMSpan, innerLLMSpan

          function outer () {
            outerLLMSpan = llmobs._active()
            innerWrapped()
          }

          function inner () {
            innerLLMSpan = llmobs._active()
            expect(innerLLMSpan.context()._tags['_ml_obs.llmobs_parent_id'])
              .to.equal(outerLLMSpan.context().toSpanId())
            // expect(innerLLMSpan.context()._tags['_ml_obs.trace_id'])
            //   .to.equal(outerLLMSpan.context()._tags['_ml_obs.trace_id'])
          }

          const outerWrapped = llmobs.wrap('workflow', outer)
          const innerWrapped = llmobs.wrap('task', inner)

          outerWrapped()
        })

        it('maintains llmobs parentage separately from apm spans', () => {
          let outerLLMObsSpan, innerLLMObsSpan

          function outerLLMObs () {
            outerLLMObsSpan = llmobs._active()
            expect(outerLLMObsSpan).to.equal(tracer.scope().active())

            apmWrapped()
          }
          function apm () {
            expect(llmobs._active()).to.equal(outerLLMObsSpan)
            innerWrapped()
          }
          function innerLLMObs () {
            innerLLMObsSpan = llmobs._active()
            expect(innerLLMObsSpan).to.equal(tracer.scope().active())
            expect(innerLLMObsSpan.context()._tags['_ml_obs.llmobs_parent_id'])
              .to.equal(outerLLMObsSpan.context().toSpanId())
            // expect(innerLLMObsSpan.context()._tags['_ml_obs.trace_id'])
            //   .to.equal(outerLLMObsSpan.context()._tags['_ml_obs.trace_id'])
          }

          const outerWrapped = llmobs.wrap('workflow', outerLLMObs)
          const apmWrapped = tracer.wrap('workflow', apm)
          const innerWrapped = llmobs.wrap('workflow', innerLLMObs)

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
        //     traceId1 = llmobs._active().context()._tags['_ml_obs.trace_id']
        //   }
        //   function llmObs2 () {
        //     traceId2 = llmobs._active().context()._tags['_ml_obs.trace_id']
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
            outerSpan = llmobs._active()
            wrappedInner1(() => {})
            expect(outerSpan).to.equal(tracer.scope().active())
            wrappedInner2()
          }

          function inner1 (cb) {
            const inner = tracer.scope().active()
            expect(llmobs._active()).to.equal(inner)
            expect(inner.context()._tags['_ml_obs.llmobs_parent_id']).to.equal(outerSpan.context().toSpanId())
            cb()
          }

          function inner2 () {
            const inner = tracer.scope().active()
            expect(llmobs._active()).to.equal(inner)
            expect(inner.context()._tags['_ml_obs.llmobs_parent_id']).to.equal(outerSpan.context().toSpanId())
          }

          const wrappedOuter = llmobs.wrap('workflow', outer)
          const wrappedInner1 = llmobs.wrap('task', inner1)
          const wrappedInner2 = llmobs.wrap('task', inner2)

          wrappedOuter()
        })
      })
    })
  })

  describe('annotate', () => {
    it('returns if llmobs is disabled', () => {
      tracer._tracer._config.llmobs.enabled = false
      llmobs.annotate()

      expect(logger.warn).to.have.been.calledWith(
        'Annotate called while LLMObs is disabled. Not annotating span.'
      )
    })

    it('returns if no arguments are provided', () => {
      llmobs.annotate()

      expect(logger.warn).to.have.been.calledWith(
        'No span provided and no active LLMObs-generated span found'
      )
    })

    it('does not annotate if there are no options given', () => {
      const span = llmobs.startSpan('llm', { name: 'test' })
      llmobs.annotate(span)

      expect(logger.warn).to.have.been.calledWith(
        'No options provided for annotation.'
      )
    })

    it('does not annotate if the provided span is not an LLMObs span', () => {
      const span = tracer.startSpan('test')

      llmobs.annotate(span, {})

      expect(logger.warn).to.have.been.calledWith(
        'Span must be an LLMObs-generated span'
      )
    })

    it('does not annotate a finished span', () => {
      llmobs.trace('workflow', { name: 'outer' }, () => {
        let innerLLMSpan
        llmobs.trace('task', { name: 'inner' }, _span => {
          innerLLMSpan = _span
        })

        llmobs.annotate(innerLLMSpan, {})

        expect(logger.warn).to.have.been.calledWith(
          'Cannot annotate a finished span'
        )
      })
    })

    it('does not annotate an llmobs span with an invalid kind', () => {
      // TODO this might end up being obsolete with llmobs span kind as optional
      const span = llmobs.startSpan('llm', { name: 'test' })
      span.context()._tags['_ml_obs.meta.span.kind'] = undefined // somehow this is set

      llmobs.annotate(span, {})

      expect(logger.warn).to.have.been.calledWith(
        'LLMObs span must have a span kind specified'
      )
    })

    it('annotates the current active llmobs span in an llmobs scope', () => {
      sinon.spy(llmobs._tagger, 'tagTextIO')

      llmobs.trace('workflow', { name: 'test' }, span => {
        const inputData = {}
        llmobs.annotate({ inputData })

        expect(llmobs._tagger.tagTextIO).to.have.been.calledWith(span, inputData, undefined)
      })
    })

    it('annotates the current active llmobs span in an apm scope', () => {
      sinon.spy(llmobs._tagger, 'tagTextIO')

      llmobs.trace('workflow', { name: 'test' }, llmobsSpan => {
        tracer.trace('apmSpan', () => {
          const inputData = {}
          llmobs.annotate({ inputData })

          expect(llmobs._tagger.tagTextIO).to.have.been.calledWith(llmobsSpan, inputData, undefined)
        })
      })
    })

    for (const spanKind of ['LLM', 'Embedding', 'Retrieval']) {
      const spanKindLowerCase = spanKind.toLowerCase()
      it(`annotates ${spanKindLowerCase} io for a ${spanKindLowerCase} span`, () => {
        sinon.spy(llmobs._tagger, `tag${spanKind}IO`)

        llmobs.trace(spanKindLowerCase, { name: 'test' }, span => {
          const inputData = {}
          llmobs.annotate({ inputData })

          expect(llmobs._tagger[`tag${spanKind}IO`]).to.have.been.calledWith(span, inputData, undefined)
        })
      })
    }

    for (const option of ['Metadata', 'Metrics', 'Tags']) {
      const optionLowerCase = option.toLowerCase()
      const method = option === 'Tags' ? 'SpanTags' : option
      it(`annotates ${optionLowerCase} if present`, () => {
        sinon.spy(llmobs._tagger, `tag${method}`)

        const span = llmobs.startSpan('llm', { name: 'test' })
        const opt = {}
        llmobs.annotate(span, { [optionLowerCase]: opt })

        expect(llmobs._tagger[`tag${method}`]).to.have.been.calledWith(span, opt)
      })
    }
  })

  describe('exportSpan', () => {
    it('returns if llmobs is disabled', () => {
      tracer._tracer._config.llmobs.enabled = false
      const spanCtx = llmobs.exportSpan()

      expect(logger.warn).to.have.been.calledWith(
        'Span exported while LLMObs is disabled. Span will not be exported.'
      )
      expect(spanCtx).to.be.undefined
    })

    it('returns if the provided span is not an LLMObs span', () => {
      const span = tracer.startSpan('test')
      const spanCtx = llmobs.exportSpan(span)

      expect(logger.warn).to.have.been.calledWith(
        'Span must be an LLMObs-generated span'
      )
      expect(spanCtx).to.be.undefined
    })

    it('returns if there is no span provided and no active llmobs span found', () => {
      const spanCtx = llmobs.exportSpan()

      expect(logger.warn).to.have.been.calledWith(
        'No span provided and no active LLMObs-generated span found'
      )
      expect(spanCtx).to.be.undefined
    })

    it('uses the provided span', () => {
      const span = llmobs.startSpan('llm', { name: 'test' })
      const spanCtx = llmobs.exportSpan(span)

      const traceId = span.context().toTraceId(true)
      const spanId = span.context().toSpanId()

      expect(spanCtx).to.deep.equal({ traceId, spanId })
    })

    it('uses the active span in an llmobs scope', () => {
      llmobs.trace('workflow', { name: 'test' }, span => {
        const spanCtx = llmobs.exportSpan()

        const traceId = span.context().toTraceId(true)
        const spanId = span.context().toSpanId()

        expect(spanCtx).to.deep.equal({ traceId, spanId })
      })
    })

    it('uses the active span in an apm scope', () => {
      llmobs.trace('workflow', { name: 'test' }, llmobsSpan => {
        tracer.trace('apmSpan', () => {
          const spanCtx = llmobs.exportSpan()

          const traceId = llmobsSpan.context().toTraceId(true)
          const spanId = llmobsSpan.context().toSpanId()

          expect(spanCtx).to.deep.equal({ traceId, spanId })
        })
      })
    })

    it('returns undefined if the provided span is not a span', () => {
      const spanCtx = llmobs.exportSpan({
        context () {
          return {
            _tags: {
              'span.type': 'llm' // mimic this somehow passing
            }
          }
        }
      })

      expect(spanCtx).to.be.undefined
      expect(logger.warn).to.have.been.calledWith(
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

      expect(logger.warn).to.have.been.calledWith(
        'LLMObs.submitEvaluation() called when LLMObs is not enabled. Evaluation metric data will not be sent.'
      )
    })

    it('does not submit an evaluation metric for a missing API key', () => {
      delete tracer._tracer._config.llmobs.apiKey
      delete tracer._tracer._config.apiKey

      llmobs.submitEvaluation(spanCtx)
      expect(logger.warn).to.have.been.calledWith(
        'DD_API_KEY is required for sending evaluation metrics. Evaluation metric data will not be sent.\n' +
        'Ensure this configuration is set before running your application.'
      )
    })

    it('does not submit an evaluation metric for an invalid span context', () => {
      const invalid = {}

      llmobs.submitEvaluation(invalid, {})
      expect(logger.warn).to.have.been.calledWith(
        'spanId and traceId must both be specified for the given evaluation metric to be submitted.'
      )
    })

    it('does not submit an evaluation metric for a missing mlApp', () => {
      delete tracer._tracer._config.llmobs.mlApp

      llmobs.submitEvaluation(spanCtx)
      expect(logger.warn).to.have.been.calledWith(
        'ML App name is required for sending evaluation metrics. Evaluation metric data will not be sent.'
      )
    })

    it('does not submit an evaluation metric for an invalid timestamp', () => {
      llmobs.submitEvaluation(spanCtx, {
        mlApp: 'test',
        timestampMs: 'invalid'
      })
      expect(logger.warn).to.have.been.calledWith(
        'timestampMs must be a non-negative integer. Evaluation metric data will not be sent'
      )
    })

    it('does not submit an evaluation metric for a missing label', () => {
      llmobs.submitEvaluation(spanCtx, {
        mlApp: 'test',
        timestampMs: 1234
      })
      expect(logger.warn).to.have.been.calledWith(
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
      expect(logger.warn).to.have.been.calledWith(
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
      expect(logger.warn).to.have.been.calledWith(
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

      expect(logger.warn).to.have.been.calledWith(
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
        tags: ['dd-trace.version:x.y.z', 'ml_app:test', 'host:localhost']
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
      sinon.restore()
    })
  })

  describe('flush', () => {
    it('does not flush if llmobs is disabled', () => {
      tracer._tracer._config.llmobs.enabled = false
      llmobs.flush()

      expect(logger.warn).to.have.been.calledWith(
        'Flushing when LLMObs is disabled. no spans or evaluation metrics will be sent'
      )
    })

    it('flushes the evaluation writer and span writer', () => {
      llmobs.flush()

      expect(llmobs._evaluationWriter.flush).to.have.been.called
      expect(llmobs._tracer._processor._llmobs._writer.flush).to.have.been.called
    })

    it('logs if there was an error flushing', () => {
      llmobs._evaluationWriter.flush.throws(new Error('boom'))

      llmobs.flush()

      expect(logger.warn).to.have.been.calledWith(
        'Failed to flush LLMObs spans and evaluation metrics'
      )
    })
  })
})
