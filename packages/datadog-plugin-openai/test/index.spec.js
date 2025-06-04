'use strict'

const fs = require('fs')
const Path = require('path')
const { expect } = require('chai')
const semver = require('semver')
const nock = require('nock')
const sinon = require('sinon')
const { spawn } = require('child_process')

const agent = require('../../dd-trace/test/plugins/agent')
const { DogStatsDClient } = require('../../dd-trace/src/dogstatsd')
const { NoopExternalLogger } = require('../../dd-trace/src/external-logger/src')
const Sampler = require('../../dd-trace/src/sampler')

const tracerRequirePath = '../../dd-trace'

const { DD_MAJOR } = require('../../../version')

describe('Plugin', () => {
  let openai
  let clock
  let metricStub
  let externalLoggerStub
  let realVersion
  let tracer

  describe('openai', () => {
    // TODO: Remove the range once we support openai 5
    withVersions('openai', 'openai', '<5.0.0', version => {
      const moduleRequirePath = `../../../versions/openai@${version}`

      before(() => {
        tracer = require(tracerRequirePath)
        return agent.load('openai')
      })

      after(() => {
        return agent.close({ ritmReset: false })
      })

      beforeEach(() => {
        clock = sinon.useFakeTimers()

        const requiredModule = require(moduleRequirePath)
        const module = requiredModule.get()
        realVersion = requiredModule.version()

        if (semver.satisfies(realVersion, '>=4.0.0')) {
          const OpenAI = module

          openai = new OpenAI({
            apiKey: 'sk-DATADOG-ACCEPTANCE-TESTS'
          })
        } else {
          const { Configuration, OpenAIApi } = module

          const configuration = new Configuration({
            apiKey: 'sk-DATADOG-ACCEPTANCE-TESTS'
          })

          openai = new OpenAIApi(configuration)
        }

        metricStub = sinon.stub(DogStatsDClient.prototype, '_add')
        externalLoggerStub = sinon.stub(NoopExternalLogger.prototype, 'log')
        sinon.stub(Sampler.prototype, 'isSampled').returns(true)
      })

      afterEach(() => {
        clock.restore()
        sinon.restore()
      })

      describe('without initialization', () => {
        it('should not error', (done) => {
          spawn('node', ['no-init'], {
            cwd: __dirname,
            stdio: 'inherit',
            env: {
              ...process.env,
              PATH_TO_DDTRACE: tracerRequirePath,
              PATH_TO_OPENAI: moduleRequirePath
            }
          }).on('exit', done) // non-zero exit status fails test
        })
      })

      describe('with error', () => {
        let scope

        beforeEach(() => {
          scope = nock('https://api.openai.com:443')
            .get('/v1/models')
            .reply(400, {
              error: {
                message: 'fake message',
                type: 'fake type',
                param: 'fake param',
                code: null
              }
            })
        })

        afterEach(() => {
          nock.removeInterceptor(scope)
          scope.done()
        })

        it('should attach the error to the span', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('error', 1)
              // the message content differs on OpenAI version, even between patches
              expect(traces[0][0].meta['error.message']).to.exist
              expect(traces[0][0].meta).to.have.property('error.type', 'Error')
              expect(traces[0][0].meta['error.stack']).to.exist
            })

          try {
            if (semver.satisfies(realVersion, '>=4.0.0')) {
              await openai.models.list()
            } else {
              await openai.listModels()
            }
          } catch {
            // ignore, we expect an error
          }

          await checkTraces

          clock.tick(10 * 1000)

          const expectedTags = ['error:1']

          expect(metricStub).to.have.been.calledWith('openai.request.error', 1, 'c', expectedTags)
          expect(metricStub).to.have.been.calledWith('openai.request.duration') // timing value not guaranteed

          expect(metricStub).to.not.have.been.calledWith('openai.tokens.prompt')
          expect(metricStub).to.not.have.been.calledWith('openai.tokens.completion')
          expect(metricStub).to.not.have.been.calledWith('openai.tokens.total')
          expect(metricStub).to.not.have.been.calledWith('openai.ratelimit.requests')
          expect(metricStub).to.not.have.been.calledWith('openai.ratelimit.tokens')
          expect(metricStub).to.not.have.been.calledWith('openai.ratelimit.remaining.requests')
          expect(metricStub).to.not.have.been.calledWith('openai.ratelimit.remaining.tokens')
        })
      })

      describe('maintains context', () => {
        afterEach(() => {
          nock.cleanAll()
        })

        it('should maintain the context with a non-streamed call', async () => {
          nock('https://api.openai.com:443')
            .post('/v1/completions')
            .reply(200, {
              id: 'cmpl-7GWDlQbOrAYGmeFZtoRdOEjDXDexM',
              object: 'text_completion',
              created: 1684171461,
              model: 'text-davinci-002',
              choices: [{
                text: 'FOO BAR BAZ',
                index: 0,
                logprobs: null,
                finish_reason: 'length'
              }],
              usage: { prompt_tokens: 3, completion_tokens: 16, total_tokens: 19 }
            })

          await tracer.trace('outer', async (outerSpan) => {
            const params = {
              model: 'text-davinci-002',
              prompt: 'Hello, \n\nFriend\t\tHi'
            }

            if (semver.satisfies(realVersion, '>=4.0.0')) {
              const result = await openai.completions.create(params)
              expect(result.id).to.eql('cmpl-7GWDlQbOrAYGmeFZtoRdOEjDXDexM')
            } else {
              const result = await openai.createCompletion(params)
              expect(result.data.id).to.eql('cmpl-7GWDlQbOrAYGmeFZtoRdOEjDXDexM')
            }

            tracer.trace('child of outer', innerSpan => {
              expect(innerSpan.context()._parentId).to.equal(outerSpan.context()._spanId)
            })
          })
        })

        if (semver.intersects('>4.1.0', version)) {
          it('should maintain the context with a streamed call', async () => {
            nock('https://api.openai.com:443')
              .post('/v1/chat/completions')
              .reply(200, function () {
                return fs.createReadStream(Path.join(__dirname, 'streamed-responses/chat.completions.simple.txt'))
              }, {
                'Content-Type': 'text/plain',
                'openai-organization': 'kill-9'
              })

            await tracer.trace('outer', async (outerSpan) => {
              const stream = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [{ role: 'user', content: 'Hello, OpenAI!', name: 'hunter2' }],
                temperature: 0.5,
                stream: true
              })

              for await (const part of stream) {
                expect(part).to.have.property('choices')
                expect(part.choices[0]).to.have.property('delta')
              }

              tracer.trace('child of outer', innerSpan => {
                expect(innerSpan.context()._parentId).to.equal(outerSpan.context()._spanId)
              })
            })
          })
        }
      })

      describe('create completion', () => {
        afterEach(() => {
          nock.cleanAll()
        })

        it('makes a successful call', async () => {
          nock('https://api.openai.com:443')
            .post('/v1/completions')
            .reply(200, {
              id: 'cmpl-7GWDlQbOrAYGmeFZtoRdOEjDXDexM',
              object: 'text_completion',
              created: 1684171461,
              model: 'text-davinci-002',
              choices: [{
                text: 'FOO BAR BAZ',
                index: 0,
                logprobs: null,
                finish_reason: 'length'
              }],
              usage: { prompt_tokens: 3, completion_tokens: 16, total_tokens: 19 }
            }, [
              'Date', 'Mon, 15 May 2023 17:24:22 GMT',
              'Content-Type', 'application/json',
              'Content-Length', '349',
              'Connection', 'close',
              'openai-model', 'text-davinci-002',
              'openai-organization', 'kill-9',
              'openai-processing-ms', '442',
              'openai-version', '2020-10-01',
              'x-ratelimit-limit-requests', '3000',
              'x-ratelimit-limit-tokens', '250000',
              'x-ratelimit-remaining-requests', '2999',
              'x-ratelimit-remaining-tokens', '249984',
              'x-ratelimit-reset-requests', '20ms',
              'x-ratelimit-reset-tokens', '3ms',
              'x-request-id', '7df89d8afe7bf24dc04e2c4dd4962d7f'
            ])

          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', 'openai.request')
              expect(traces[0][0]).to.have.property('type', 'openai')
              if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                expect(traces[0][0]).to.have.property('resource', 'completions.create')
              } else {
                expect(traces[0][0]).to.have.property('resource', 'createCompletion')
              }
              expect(traces[0][0]).to.have.property('error', 0)
              expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')
              expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/completions')

              expect(traces[0][0].meta).to.have.property('component', 'openai')
              expect(traces[0][0].meta).to.have.property('openai.api_base', 'https://api.openai.com/v1')
              expect(traces[0][0].meta).to.have.property('openai.organization.name', 'kill-9')
              expect(traces[0][0].meta).to.have.property('openai.request.model', 'text-davinci-002')
              expect(traces[0][0].meta).to.have.property('openai.request.prompt', 'Hello, \\n\\nFriend\\t\\tHi')
              expect(traces[0][0].meta).to.have.property('openai.request.stop', 'time')
              expect(traces[0][0].meta).to.have.property('openai.request.suffix', 'foo')
              expect(traces[0][0].meta).to.have.property('openai.request.user', 'hunter2')
              expect(traces[0][0].meta).to.have.property('openai.response.choices.0.finish_reason', 'length')
              expect(traces[0][0].meta).to.have.property('openai.response.choices.0.logprobs', 'returned')
              expect(traces[0][0].meta).to.have.property('openai.response.choices.0.text', 'FOO BAR BAZ')
              expect(traces[0][0].meta).to.have.property('openai.response.model', 'text-davinci-002')
              expect(traces[0][0].meta).to.have.property('openai.user.api_key', 'sk-...ESTS')
              expect(traces[0][0].metrics).to.have.property('openai.request.best_of', 2)
              expect(traces[0][0].metrics).to.have.property('openai.request.echo', 0)
              expect(traces[0][0].metrics).to.have.property('openai.request.frequency_penalty', 0.11)
              expect(traces[0][0].metrics).to.have.property('openai.request.logit_bias.50256', 30)
              expect(traces[0][0].metrics).to.have.property('openai.request.logprobs', 3)
              expect(traces[0][0].metrics).to.have.property('openai.request.max_tokens', 7)
              expect(traces[0][0].metrics).to.have.property('openai.request.n', 1)
              expect(traces[0][0].metrics).to.have.property('openai.request.presence_penalty', -0.1)
              expect(traces[0][0].metrics).to.have.property('openai.request.temperature', 1.01)
              expect(traces[0][0].metrics).to.have.property('openai.request.top_p', 0.9)
              expect(traces[0][0].metrics).to.have.property('openai.response.usage.completion_tokens', 16)
              expect(traces[0][0].metrics).to.have.property('openai.response.usage.prompt_tokens', 3)
              expect(traces[0][0].metrics).to.have.property('openai.response.usage.total_tokens', 19)
            })

          const params = {
            model: 'text-davinci-002',
            prompt: 'Hello, \n\nFriend\t\tHi',
            suffix: 'foo',
            max_tokens: 7,
            temperature: 1.01,
            top_p: 0.9,
            n: 1,
            stream: false,
            logprobs: 3,
            echo: false,
            stop: 'time',
            presence_penalty: -0.1,
            frequency_penalty: 0.11,
            best_of: 2,
            logit_bias: { 50256: 30 },
            user: 'hunter2'
          }

          if (semver.satisfies(realVersion, '>=4.0.0')) {
            const result = await openai.completions.create(params)
            expect(result.id).to.eql('cmpl-7GWDlQbOrAYGmeFZtoRdOEjDXDexM')
          } else {
            const result = await openai.createCompletion(params)
            expect(result.data.id).to.eql('cmpl-7GWDlQbOrAYGmeFZtoRdOEjDXDexM')
          }

          await checkTraces

          clock.tick(10 * 1000)

          const expectedTags = [
            'error:0',
            'org:kill-9',
            'endpoint:/v1/completions',
            'model:text-davinci-002'
          ]

          expect(metricStub).to.have.been.calledWith('openai.request.duration') // timing value not guaranteed
          expect(metricStub).to.have.been.calledWith('openai.tokens.prompt', 3, 'd', expectedTags)
          expect(metricStub).to.have.been.calledWith('openai.tokens.completion', 16, 'd', expectedTags)
          expect(metricStub).to.have.been.calledWith('openai.tokens.total', 19, 'd', expectedTags)

          expect(metricStub).to.have.been.calledWith('openai.ratelimit.requests', 3000, 'g', expectedTags)
          expect(metricStub).to.have.been.calledWith('openai.ratelimit.tokens', 250000, 'g', expectedTags)
          expect(metricStub).to.have.been.calledWith('openai.ratelimit.remaining.requests', 2999, 'g', expectedTags)
          expect(metricStub).to.have.been.calledWith('openai.ratelimit.remaining.tokens', 249984, 'g', expectedTags)

          expect(externalLoggerStub).to.have.been.calledWith({
            status: 'info',
            message: semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6
              ? 'sampled completions.create'
              : 'sampled createCompletion',
            prompt: 'Hello, \n\nFriend\t\tHi',
            choices: [
              {
                text: 'FOO BAR BAZ',
                index: 0,
                logprobs: null,
                finish_reason: 'length'
              }
            ]
          })
        })

        it('should not throw with empty response body', async () => {
          nock('https://api.openai.com:443')
            .post('/v1/completions')
            .reply(200, {}, [
              'Date', 'Mon, 15 May 2023 17:24:22 GMT',
              'Content-Type', 'application/json',
              'Content-Length', '349',
              'Connection', 'close',
              'openai-model', 'text-davinci-002',
              'openai-organization', 'kill-9',
              'openai-processing-ms', '442',
              'openai-version', '2020-10-01',
              'x-ratelimit-limit-requests', '3000',
              'x-ratelimit-limit-tokens', '250000',
              'x-ratelimit-remaining-requests', '2999',
              'x-ratelimit-remaining-tokens', '249984',
              'x-ratelimit-reset-requests', '20ms',
              'x-ratelimit-reset-tokens', '3ms',
              'x-request-id', '7df89d8afe7bf24dc04e2c4dd4962d7f'
            ])

          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', 'openai.request')
            })

          const params = {
            model: 'text-davinci-002',
            prompt: 'Hello, ',
            suffix: 'foo'
          }

          if (semver.satisfies(realVersion, '>=4.0.0')) {
            await openai.completions.create(params)
          } else {
            await openai.createCompletion(params)
          }

          await checkTraces

          clock.tick(10 * 1000)
        })
      })

      describe('create embedding with stream:true', () => {
        after(() => {
          nock.cleanAll()
        })

        it('makes a successful call', async () => {
          nock('https://api.openai.com:443')
            .post('/v1/embeddings')
            .reply(200, {
              object: 'list',
              data: [{
                object: 'embedding',
                index: 0,
                embedding: [-0.0034387498, -0.026400521]
              }],
              model: 'text-embedding-ada-002-v2',
              usage: {
                prompt_tokens: 2,
                total_tokens: 2
              }
            }, [
              'Date', 'Mon, 15 May 2023 20:49:06 GMT',
              'Content-Type', 'application/json',
              'Content-Length', '75',
              'access-control-allow-origin', '*',
              'openai-organization', 'kill-9',
              'openai-processing-ms', '344',
              'openai-version', '2020-10-01'
            ])

          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', 'openai.request')
              expect(traces[0][0]).to.have.property('type', 'openai')
              if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                expect(traces[0][0]).to.have.property('resource', 'embeddings.create')
              } else {
                expect(traces[0][0]).to.have.property('resource', 'createEmbedding')
              }
              expect(traces[0][0]).to.have.property('error', 0)
              expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/embeddings')
              expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')

              expect(traces[0][0].meta).to.have.property('openai.organization.name', 'kill-9')
              expect(traces[0][0].meta).to.have.property('openai.request.input', 'Cat?')
              expect(traces[0][0].meta).to.have.property('openai.request.model', 'text-embedding-ada-002')
              expect(traces[0][0].meta).to.have.property('openai.request.user', 'hunter2')
              expect(traces[0][0].meta).to.have.property('openai.response.model', 'text-embedding-ada-002-v2')
              expect(traces[0][0].metrics).to.have.property('openai.response.embeddings_count', 1)
              expect(traces[0][0].metrics).to.have.property('openai.response.embedding.0.embedding_length', 2)
              expect(traces[0][0].metrics).to.have.property('openai.response.usage.prompt_tokens', 2)
              expect(traces[0][0].metrics).to.have.property('openai.response.usage.total_tokens', 2)
            })

          const params = {
            model: 'text-embedding-ada-002',
            input: 'Cat?',
            user: 'hunter2',
            encoding_format: 'float'
          }

          if (semver.satisfies(realVersion, '>=4.0.0')) {
            const result = await openai.embeddings.create(params)
            expect(result.model).to.eql('text-embedding-ada-002-v2')
          } else {
            const result = await openai.createEmbedding(params)
            expect(result.data.model).to.eql('text-embedding-ada-002-v2')
          }

          await checkTraces

          expect(externalLoggerStub).to.have.been.calledWith({
            status: 'info',
            message: semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6
              ? 'sampled embeddings.create'
              : 'sampled createEmbedding',
            input: 'Cat?'
          })
        })

        it('makes a successful call with stream true', async () => {
          // Testing that adding stream:true to the params doesn't break the instrumentation
          nock('https://api.openai.com:443')
            .post('/v1/embeddings')
            .reply(200, {
              object: 'list',
              data: [{
                object: 'embedding',
                index: 0,
                embedding: [-0.0034387498, -0.026400521]
              }],
              model: 'text-embedding-ada-002-v2',
              usage: {
                prompt_tokens: 2,
                total_tokens: 2
              }
            }, [
              'Date', 'Mon, 15 May 2023 20:49:06 GMT',
              'Content-Type', 'application/json',
              'Content-Length', '75',
              'access-control-allow-origin', '*',
              'openai-organization', 'kill-9',
              'openai-processing-ms', '344',
              'openai-version', '2020-10-01'
            ])

          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', 'openai.request')
              expect(traces[0][0]).to.have.property('type', 'openai')
              if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                expect(traces[0][0]).to.have.property('resource', 'embeddings.create')
              } else {
                expect(traces[0][0]).to.have.property('resource', 'createEmbedding')
              }
              expect(traces[0][0]).to.have.property('error', 0)
              expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/embeddings')
              expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')

              expect(traces[0][0].meta).to.have.property('openai.organization.name', 'kill-9')
              expect(traces[0][0].meta).to.have.property('openai.request.input', 'Cat?')
              expect(traces[0][0].meta).to.have.property('openai.request.model', 'text-embedding-ada-002')
              expect(traces[0][0].meta).to.have.property('openai.request.user', 'hunter2')
              expect(traces[0][0].meta).to.have.property('openai.response.model', 'text-embedding-ada-002-v2')
              expect(traces[0][0].metrics).to.have.property('openai.response.embeddings_count', 1)
              expect(traces[0][0].metrics).to.have.property('openai.response.embedding.0.embedding_length', 2)
              expect(traces[0][0].metrics).to.have.property('openai.response.usage.prompt_tokens', 2)
              expect(traces[0][0].metrics).to.have.property('openai.response.usage.total_tokens', 2)
            })

          const params = {
            model: 'text-embedding-ada-002',
            input: 'Cat?',
            user: 'hunter2',
            stream: true,
            encoding_format: 'float'
          }

          if (semver.satisfies(realVersion, '>=4.0.0')) {
            const result = await openai.embeddings.create(params)
            expect(result.model).to.eql('text-embedding-ada-002-v2')
          } else {
            const result = await openai.createEmbedding(params)
            expect(result.data.model).to.eql('text-embedding-ada-002-v2')
          }

          await checkTraces

          expect(externalLoggerStub).to.have.been.calledWith({
            status: 'info',
            message: semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6
              ? 'sampled embeddings.create'
              : 'sampled createEmbedding',
            input: 'Cat?'
          })
        })
      })

      describe('embedding with missing usages', () => {
        afterEach(() => {
          nock.cleanAll()
        })

        it('makes a successful call', async () => {
          nock('https://api.openai.com:443')
            .post('/v1/embeddings')
            .reply(200, {
              object: 'list',
              data: [{
                object: 'embedding',
                index: 0,
                embedding: [-0.0034387498, -0.026400521]
              }],
              model: 'text-embedding-ada-002-v2',
              usage: {
                prompt_tokens: 0
              }
            }, [])

          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0][0].metrics).to.have.property('openai.response.usage.prompt_tokens', 0)
              expect(traces[0][0].metrics).to.not.have.property('openai.response.usage.completion_tokens')
              expect(traces[0][0].metrics).to.not.have.property('openai.response.usage.total_tokens')
            })

          const params = {
            model: 'text-embedding-ada-002',
            input: '',
            user: 'hunter2',
            encoding_format: 'float'
          }

          if (semver.satisfies(realVersion, '>=4.0.0')) {
            const result = await openai.embeddings.create(params)
            expect(result.model).to.eql('text-embedding-ada-002-v2')
          } else {
            const result = await openai.createEmbedding(params)
            expect(result.data.model).to.eql('text-embedding-ada-002-v2')
          }

          await checkTraces

          expect(metricStub).to.have.been.calledWith('openai.request.duration') // timing value not guaranteed
          expect(metricStub).to.have.been.calledWith('openai.tokens.prompt')
          expect(metricStub).to.not.have.been.calledWith('openai.tokens.completion')
          expect(metricStub).to.not.have.been.calledWith('openai.tokens.total')
        })
      })

      describe('list models', () => {
        let scope

        before(() => {
          scope = nock('https://api.openai.com:443')
            .get('/v1/models')
            .reply(200, {
              object: 'list',
              data: [
                {
                  id: 'whisper-1',
                  object: 'model',
                  created: 1677532384,
                  owned_by: 'openai-internal',
                  permission: [{
                    id: 'modelperm-KlsZlfft3Gma8pI6A8rTnyjs',
                    object: 'model_permission',
                    created: 1683912666,
                    allow_create_engine: false,
                    allow_sampling: true,
                    allow_logprobs: true,
                    allow_search_indices: false,
                    allow_view: true,
                    allow_fine_tuning: false,
                    organization: '*',
                    group: null,
                    is_blocking: false
                  }],
                  root: 'whisper-1',
                  parent: null
                },
                {
                  id: 'babbage',
                  object: 'model',
                  created: 1649358449,
                  owned_by: 'openai',
                  permission: [{
                    id: 'modelperm-49FUp5v084tBB49tC4z8LPH5',
                    object: 'model_permission',
                    created: 1669085501,
                    allow_create_engine: false,
                    allow_sampling: true,
                    allow_logprobs: true,
                    allow_search_indices: false,
                    allow_view: true,
                    allow_fine_tuning: false,
                    organization: '*',
                    group: null,
                    is_blocking: false
                  }],
                  root: 'babbage',
                  parent: null
                }
              ]
            }, [
              'Date', 'Mon, 15 May 2023 23:26:42 GMT',
              'Content-Type', 'application/json',
              'Content-Length', '63979',
              'Connection', 'close',
              'openai-version', '2020-10-01',
              'openai-processing-ms', '164'
            ])
        })

        after(() => {
          nock.removeInterceptor(scope)
          scope.done()
        })

        it('makes a successful call', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', 'openai.request')
              expect(traces[0][0]).to.have.property('type', 'openai')
              if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                expect(traces[0][0]).to.have.property('resource', 'models.list')
              } else {
                expect(traces[0][0]).to.have.property('resource', 'listModels')
              }
              expect(traces[0][0]).to.have.property('error', 0)
              expect(traces[0][0].meta).to.have.property('openai.request.method', 'GET')
              expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/models')

              expect(traces[0][0].metrics).to.have.property('openai.response.count', 2)
              // Note that node doesn't accept a user value
            })

          if (semver.satisfies(realVersion, '>=4.0.0')) {
            const result = await openai.models.list()
            expect(result.object).to.eql('list')
            expect(result.data.length).to.eql(2)
          } else {
            const result = await openai.listModels()
            expect(result.data.object).to.eql('list')
            expect(result.data.data.length).to.eql(2)
          }

          await checkTraces
        })
      })

      describe('retrieve model', () => {
        let scope

        before(() => {
          scope = nock('https://api.openai.com:443')
            .get('/v1/models/gpt-4')
            .reply(200, {
              id: 'gpt-4',
              object: 'model',
              created: 1678604602,
              owned_by: 'openai',
              permission: [{
                id: 'modelperm-ffiDrbtOGIZuczdJcFuOo2Mi',
                object: 'model_permission',
                created: 1684185078,
                allow_create_engine: false,
                allow_sampling: false,
                allow_logprobs: false,
                allow_search_indices: false,
                allow_view: false,
                allow_fine_tuning: false,
                organization: '*',
                group: null,
                is_blocking: false
              }],
              root: 'gpt-4',
              parent: 'stevebob'
            }, [
              'Date', 'Mon, 15 May 2023 23:41:40 GMT',
              'Content-Type', 'application/json',
              'Content-Length', '548',
              'Connection', 'close',
              'openai-version', '2020-10-01',
              'openai-processing-ms', '27'
            ])
        })

        after(() => {
          nock.removeInterceptor(scope)
          scope.done()
        })

        it('makes a successful call', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', 'openai.request')
              expect(traces[0][0]).to.have.property('type', 'openai')
              if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                expect(traces[0][0]).to.have.property('resource', 'models.retrieve')
              } else {
                expect(traces[0][0]).to.have.property('resource', 'retrieveModel')
              }
              expect(traces[0][0]).to.have.property('error', 0)
              expect(traces[0][0].meta).to.have.property('openai.request.method', 'GET')
              expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/models/*')

              // expect(traces[0][0].meta).to.have.property('openai.response.permission.group', null)
              expect(traces[0][0].meta).to.have.property('openai.request.id', 'gpt-4')
              expect(traces[0][0].meta).to.have.property('openai.response.owned_by', 'openai')
              expect(traces[0][0].meta).to.have.property('openai.response.parent', 'stevebob')
              expect(traces[0][0].meta).to.have.property('openai.response.permission.id',
                'modelperm-ffiDrbtOGIZuczdJcFuOo2Mi')
              expect(traces[0][0].meta).to.have.property('openai.response.permission.organization', '*')
              expect(traces[0][0].meta).to.have.property('openai.response.root', 'gpt-4')
              expect(traces[0][0].metrics).to.have.property('openai.response.permission.allow_create_engine', 0)
              expect(traces[0][0].metrics).to.have.property('openai.response.permission.allow_fine_tuning', 0)
              expect(traces[0][0].metrics).to.have.property('openai.response.permission.allow_logprobs', 0)
              expect(traces[0][0].metrics).to.have.property('openai.response.permission.allow_sampling', 0)
              expect(traces[0][0].metrics).to.have.property('openai.response.permission.allow_search_indices', 0)
              expect(traces[0][0].metrics).to.have.property('openai.response.permission.allow_view', 0)
              expect(traces[0][0].metrics).to.have.property('openai.response.permission.created', 1684185078)
              expect(traces[0][0].metrics).to.have.property('openai.response.permission.is_blocking', 0)
            })

          if (semver.satisfies(realVersion, '>=4.0.0')) {
            const result = await openai.models.retrieve('gpt-4')

            expect(result.id).to.eql('gpt-4')
          } else {
            const result = await openai.retrieveModel('gpt-4')

            expect(result.data.id).to.eql('gpt-4')
          }

          await checkTraces
        })
      })

      describe('create edit', () => {
        let scope

        before(() => {
          scope = nock('https://api.openai.com:443')
            .post('/v1/edits')
            .reply(200, {
              object: 'edit',
              created: 1684267309,
              choices: [{
                text: 'What day of the week is it, Bob?\n',
                index: 0
              }],
              usage: {
                prompt_tokens: 25,
                completion_tokens: 28,
                total_tokens: 53
              }
            }, [
              'Date', 'Tue, 16 May 2023 20:01:49 GMT',
              'Content-Type', 'application/json',
              'Content-Length', '172',
              'Connection', 'close',
              'openai-model', 'text-davinci-edit:001',
              'openai-organization', 'kill-9',
              'openai-processing-ms', '920',
              'openai-version', '2020-10-01',
              'x-ratelimit-limit-requests', '20',
              'x-ratelimit-remaining-requests', '19',
              'x-ratelimit-reset-requests', '3s',
              'x-request-id', 'aa28029fd9758334bcead67af867e8fc'

            ])
        })

        after(() => {
          nock.removeInterceptor(scope)
          scope.done()
        })

        if (semver.satisfies(realVersion, '<4.0.0')) {
          // `edits.create` was deprecated and removed after 4.0.0
          it('makes a successful call', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('name', 'openai.request')
                expect(traces[0][0]).to.have.property('type', 'openai')
                expect(traces[0][0]).to.have.property('resource', 'createEdit')
                expect(traces[0][0]).to.have.property('error', 0)
                expect(traces[0][0].meta).to.have.property('openai.organization.name', 'kill-9')
                expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')
                expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/edits')

                expect(traces[0][0].meta).to.have.property('openai.request.input', 'What day of the wek is it?')
                expect(traces[0][0].meta).to.have.property('openai.request.instruction', 'Fix the spelling mistakes')
                expect(traces[0][0].meta).to.have.property('openai.request.model', 'text-davinci-edit-001')
                expect(traces[0][0].meta).to.have.property('openai.request.user', 'hunter2')
                expect(traces[0][0].meta).to.have.property('openai.response.choices.0.text',
                  'What day of the week is it, Bob?\\n')
                expect(traces[0][0].metrics).to.have.property('openai.request.n', 1)
                expect(traces[0][0].metrics).to.have.property('openai.request.temperature', 1.00001)
                expect(traces[0][0].metrics).to.have.property('openai.request.top_p', 0.999)
                expect(traces[0][0].metrics).to.have.property('openai.response.choices_count', 1)
                expect(traces[0][0].metrics).to.have.property('openai.response.created', 1684267309)
                expect(traces[0][0].metrics).to.have.property('openai.response.usage.completion_tokens', 28)
                expect(traces[0][0].metrics).to.have.property('openai.response.usage.prompt_tokens', 25)
                expect(traces[0][0].metrics).to.have.property('openai.response.usage.total_tokens', 53)
              })

            const result = await openai.createEdit({
              model: 'text-davinci-edit-001',
              input: 'What day of the wek is it?',
              instruction: 'Fix the spelling mistakes',
              n: 1,
              temperature: 1.00001,
              top_p: 0.999,
              user: 'hunter2'
            })

            expect(result.data.choices[0].text).to.eql('What day of the week is it, Bob?\n')

            clock.tick(10 * 1000)

            await checkTraces

            const expectedTags = [
              'error:0',
              'org:kill-9',
              'endpoint:/v1/edits',
              'model:text-davinci-edit:001'
            ]

            expect(metricStub).to.be.calledWith('openai.ratelimit.requests', 20, 'g', expectedTags)
            expect(metricStub).to.be.calledWith('openai.ratelimit.remaining.requests', 19, 'g', expectedTags)

            expect(externalLoggerStub).to.have.been.calledWith({
              status: 'info',
              message: semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6
                ? 'sampled edits.create'
                : 'sampled createEdit',
              input: 'What day of the wek is it?',
              instruction: 'Fix the spelling mistakes',
              choices: [{
                text: 'What day of the week is it, Bob?\n',
                index: 0
              }]
            })
          })
        }
      })

      describe('list files', () => {
        let scope

        before(() => {
          scope = nock('https://api.openai.com:443')
            .get('/v1/files')
            .reply(200, {
              object: 'list',
              data: [{
                object: 'file',
                id: 'file-foofoofoo',
                purpose: 'fine-tune-results',
                filename: 'compiled_results.csv',
                bytes: 3460,
                created_at: 1684000162,
                status: 'processed',
                status_details: null
              }, {
                object: 'file',
                id: 'file-barbarbar',
                purpose: 'fine-tune-results',
                filename: 'compiled_results.csv',
                bytes: 13595,
                created_at: 1684000508,
                status: 'processed',
                status_details: null
              }]
            }, [
              'Date', 'Wed, 17 May 2023 21:34:04 GMT',
              'Content-Type', 'application/json',
              'Content-Length', '25632',
              'Connection', 'close',
              'openai-version', '2020-10-01',
              'openai-organization', 'kill-9',
              'openai-processing-ms', '660'
            ])
        })

        after(() => {
          nock.removeInterceptor(scope)
          scope.done()
        })

        it('makes a successful call', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', 'openai.request')
              expect(traces[0][0]).to.have.property('type', 'openai')
              if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                expect(traces[0][0]).to.have.property('resource', 'files.list')
              } else {
                expect(traces[0][0]).to.have.property('resource', 'listFiles')
              }
              expect(traces[0][0]).to.have.property('error', 0)
              expect(traces[0][0].meta).to.have.property('openai.organization.name', 'kill-9')

              expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/files')
              expect(traces[0][0].meta).to.have.property('openai.request.method', 'GET')
              expect(traces[0][0].metrics).to.have.property('openai.response.count', 2)
            })

          if (semver.satisfies(realVersion, '>=4.0.0')) {
            const result = await openai.files.list()

            expect(result.data.length).to.eql(2)
            expect(result.data[0].id).to.eql('file-foofoofoo')
          } else {
            const result = await openai.listFiles()

            expect(result.data.data.length).to.eql(2)
            expect(result.data.data[0].id).to.eql('file-foofoofoo')
          }

          await checkTraces
        })
      })

      describe('create file', () => {
        let scope

        before(() => {
          scope = nock('https://api.openai.com:443')
            .post('/v1/files')
            .reply(200, {
              object: 'file',
              id: 'file-268aYWYhvxWwHb4nIzP9FHM6',
              purpose: 'fine-tune',
              filename: 'dave-hal.jsonl',
              bytes: 356,
              created_at: 1684362764,
              status: 'uploaded',
              status_details: 'foo' // dummy value for testing
            }, [
              'Date', 'Wed, 17 May 2023 22:32:44 GMT',
              'Content-Type', 'application/json',
              'Content-Length', '216',
              'Connection', 'close',
              'openai-version', '2020-10-01',
              'openai-organization', 'kill-9',
              'openai-processing-ms', '1021'
            ])
        })

        after(() => {
          nock.removeInterceptor(scope)
          scope.done()
        })

        it('makes a successful call', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', 'openai.request')
              expect(traces[0][0]).to.have.property('type', 'openai')
              if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                expect(traces[0][0]).to.have.property('resource', 'files.create')
              } else {
                expect(traces[0][0]).to.have.property('resource', 'createFile')
              }
              expect(traces[0][0]).to.have.property('error', 0)
              expect(traces[0][0].meta).to.have.property('openai.organization.name', 'kill-9')
              expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/files')
              expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')

              expect(traces[0][0].meta).to.have.property('openai.request.filename', 'dave-hal.jsonl')
              expect(traces[0][0].meta).to.have.property('openai.request.purpose', 'fine-tune')
              expect(traces[0][0].meta).to.have.property('openai.response.purpose', 'fine-tune')
              expect(traces[0][0].meta).to.have.property('openai.response.status', 'uploaded')
              expect(traces[0][0].meta).to.have.property('openai.response.status_details', 'foo')
              expect(traces[0][0].meta).to.have.property('openai.response.id', 'file-268aYWYhvxWwHb4nIzP9FHM6')
              expect(traces[0][0].meta).to.have.property('openai.response.filename', 'dave-hal.jsonl')
              expect(traces[0][0].metrics).to.have.property('openai.response.bytes', 356)
              expect(traces[0][0].metrics).to.have.property('openai.response.created_at', 1684362764)
            })

          if (semver.satisfies(realVersion, '>=4.0.0')) {
            const result = await openai.files.create({
              file: fs.createReadStream(Path.join(__dirname, 'dave-hal.jsonl')),
              purpose: 'fine-tune'
            })

            expect(result.filename).to.eql('dave-hal.jsonl')
          } else {
            const result = await openai.createFile(fs.createReadStream(
              Path.join(__dirname, 'dave-hal.jsonl')), 'fine-tune')

            expect(result.data.filename).to.eql('dave-hal.jsonl')
          }

          await checkTraces
        })
      })

      describe('delete file', () => {
        let scope

        before(() => {
          scope = nock('https://api.openai.com:443')
            .delete('/v1/files/file-268aYWYhvxWwHb4nIzP9FHM6')
            .reply(200, {
              object: 'file',
              id: 'file-268aYWYhvxWwHb4nIzP9FHM6',
              deleted: true
            }, [
              'Date', 'Wed, 17 May 2023 23:03:54 GMT',
              'Content-Type', 'application/json',
              'Content-Length', '83',
              'Connection', 'close',
              'openai-version', '2020-10-01',
              'openai-organization', 'kill-9'
            ])
        })

        after(() => {
          nock.removeInterceptor(scope)
          scope.done()
        })

        it('makes a successful call', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', 'openai.request')
              expect(traces[0][0]).to.have.property('type', 'openai')
              if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                expect(traces[0][0]).to.have.property('resource', 'files.del')
              } else {
                expect(traces[0][0]).to.have.property('resource', 'deleteFile')
              }
              expect(traces[0][0]).to.have.property('error', 0)
              expect(traces[0][0].meta).to.have.property('openai.organization.name', 'kill-9')
              expect(traces[0][0].meta).to.have.property('openai.request.method', 'DELETE')
              expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/files/*')

              expect(traces[0][0].meta).to.have.property('openai.request.file_id', 'file-268aYWYhvxWwHb4nIzP9FHM6')
              expect(traces[0][0].meta).to.have.property('openai.response.id', 'file-268aYWYhvxWwHb4nIzP9FHM6')
              expect(traces[0][0].metrics).to.have.property('openai.response.deleted', 1)
            })

          if (semver.satisfies(realVersion, '>=4.0.0')) {
            const result = await openai.files.del('file-268aYWYhvxWwHb4nIzP9FHM6')

            expect(result.deleted).to.eql(true)
          } else {
            const result = await openai.deleteFile('file-268aYWYhvxWwHb4nIzP9FHM6')

            expect(result.data.deleted).to.eql(true)
          }

          await checkTraces
        })
      })

      describe('retrieve file', () => {
        let scope

        before(() => {
          scope = nock('https://api.openai.com:443')
            .get('/v1/files/file-fIkEUgQPWnVXNKPJsr4pEWiz')
            .reply(200, {
              object: 'file',
              id: 'file-fIkEUgQPWnVXNKPJsr4pEWiz',
              purpose: 'fine-tune',
              filename: 'dave-hal.jsonl',
              bytes: 356,
              created_at: 1684362764,
              status: 'uploaded',
              status_details: 'foo' // dummy value for testing
            }, [
              'Date', 'Wed, 17 May 2023 23:14:02 GMT',
              'Content-Type', 'application/json',
              'Content-Length', '240',
              'Connection', 'close',
              'openai-version', '2020-10-01',
              'openai-organization', 'kill-9',
              'openai-processing-ms', '18'
            ])
        })

        after(() => {
          nock.removeInterceptor(scope)
          scope.done()
        })

        it('makes a successful call', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', 'openai.request')
              expect(traces[0][0]).to.have.property('type', 'openai')
              if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                expect(traces[0][0]).to.have.property('resource', 'files.retrieve')
              } else {
                expect(traces[0][0]).to.have.property('resource', 'retrieveFile')
              }
              expect(traces[0][0]).to.have.property('error', 0)
              expect(traces[0][0].meta).to.have.property('openai.organization.name', 'kill-9')
              expect(traces[0][0].meta).to.have.property('openai.request.method', 'GET')
              expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/files/*')

              expect(traces[0][0].meta).to.have.property('openai.request.file_id', 'file-fIkEUgQPWnVXNKPJsr4pEWiz')
              expect(traces[0][0].meta).to.have.property('openai.response.filename', 'dave-hal.jsonl')
              expect(traces[0][0].meta).to.have.property('openai.response.id', 'file-fIkEUgQPWnVXNKPJsr4pEWiz')
              expect(traces[0][0].meta).to.have.property('openai.response.purpose', 'fine-tune')
              expect(traces[0][0].meta).to.have.property('openai.response.status', 'uploaded')
              expect(traces[0][0].meta).to.have.property('openai.response.status_details', 'foo')
              expect(traces[0][0].metrics).to.have.property('openai.response.bytes', 356)
              expect(traces[0][0].metrics).to.have.property('openai.response.created_at', 1684362764)
            })

          if (semver.satisfies(realVersion, '>=4.0.0')) {
            const result = await openai.files.retrieve('file-fIkEUgQPWnVXNKPJsr4pEWiz')

            expect(result.filename).to.eql('dave-hal.jsonl')
          } else {
            const result = await openai.retrieveFile('file-fIkEUgQPWnVXNKPJsr4pEWiz')

            expect(result.data.filename).to.eql('dave-hal.jsonl')
          }

          await checkTraces
        })
      })

      describe('download file', () => {
        let scope

        before(() => {
          scope = nock('https://api.openai.com:443')
            .get('/v1/files/file-t3k1gVSQDHrfZnPckzftlZ4A/content')
            .reply(200, '{"prompt": "foo?", "completion": "bar."}\n{"prompt": "foofoo?", "completion": "barbar."}\n', [
              'Date', 'Wed, 17 May 2023 23:26:01 GMT',
              'Content-Type', 'application/octet-stream',
              'Transfer-Encoding', 'chunked',
              'Connection', 'close',
              'content-disposition', 'attachment; filename="dave-hal.jsonl"',
              'openai-version', '2020-10-01',
              'openai-organization', 'kill-9',
              'openai-processing-ms', '128'
            ])
        })

        after(() => {
          nock.removeInterceptor(scope)
          scope.done()
        })

        // TODO: issues with content being async arraybuffer, how to compute byteLength before promise resolves?
        it('makes a successful call', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', 'openai.request')
              expect(traces[0][0]).to.have.property('type', 'openai')
              if (semver.satisfies(realVersion, '>=4.0.0 <4.17.1') && DD_MAJOR < 6) {
                expect(traces[0][0]).to.have.property('resource', 'files.retrieveContent')
              } else if (semver.satisfies(realVersion, '>=4.17.1') && DD_MAJOR < 6) {
                expect(traces[0][0]).to.have.property('resource', 'files.content')
              } else {
                expect(traces[0][0]).to.have.property('resource', 'downloadFile')
              }
              expect(traces[0][0]).to.have.property('error', 0)
              expect(traces[0][0].meta).to.have.property('openai.organization.name', 'kill-9')
              expect(traces[0][0].meta).to.have.property('openai.request.method', 'GET')
              expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/files/*/content')

              expect(traces[0][0].meta).to.have.property('openai.request.file_id', 'file-t3k1gVSQDHrfZnPckzftlZ4A')
              if (semver.satisfies(realVersion, '<4.17.0')) {
                expect(traces[0][0].metrics).to.have.property('openai.response.total_bytes', 88)
              }
            })

          if (semver.satisfies(realVersion, '>=4.0.0 < 4.17.1')) {
            const result = await openai.files.retrieveContent('file-t3k1gVSQDHrfZnPckzftlZ4A')

            expect(result)
              .to.eql('{"prompt": "foo?", "completion": "bar."}\n{"prompt": "foofoo?", "completion": "barbar."}\n')
          } else if (semver.satisfies(realVersion, '>=4.17.1')) {
            const result = await openai.files.content('file-t3k1gVSQDHrfZnPckzftlZ4A')

            expect(result.constructor.name).to.eql('Response')
          } else {
            const result = await openai.downloadFile('file-t3k1gVSQDHrfZnPckzftlZ4A')

            /**
             * TODO: Seems like an OpenAI library bug?
             * downloading single line JSONL file results in the JSON being converted into an object.
             * downloading multi-line JSONL file then provides a basic string.
             * This suggests the library is doing `try { return JSON.parse(x) } catch { return x }`
             */
            expect(result.data[0]).to.eql('{') // raw JSONL file
          }

          await checkTraces
        })
      })

      describe('create finetune', () => {
        let scope

        beforeEach(() => {
          const response = {
            id: 'ft-10RCfqSvgyEcauomw7VpiYco',
            created_at: 1684442489,
            updated_at: 1684442489,
            organization_id: 'org-COOLORG',
            model: 'curie',
            fine_tuned_model: 'huh',
            status: 'pending',
            result_files: []
          }
          if (semver.satisfies(realVersion, '>=4.1.0')) {
            response.object = 'fine_tuning.job'
            response.hyperparameters = {
              n_epochs: 5,
              batch_size: 3,
              prompt_loss_weight: 0.01,
              learning_rate_multiplier: 0.1
            }
            response.validation_file = null
            response.training_file = 'file-t3k1gVSQDHrfZnPckzftlZ4A'
          } else {
            response.object = 'fine-tunes'
            response.hyperparams = {
              n_epochs: 5,
              batch_size: 3,
              prompt_loss_weight: 0.01,
              learning_rate_multiplier: 0.1
            }
            response.training_files = [{
              object: 'file',
              id: 'file-t3k1gVSQDHrfZnPckzftlZ4A',
              purpose: 'fine-tune',
              filename: 'dave-hal.jsonl',
              bytes: 356,
              created_at: 1684365950,
              status: 'processed',
              status_details: null
            }]
            response.validation_files = []
            response.events = [{
              object: 'fine-tune-event',
              level: 'info',
              message: 'Created fine-tune: ft-10RCfqSvgyEcauomw7VpiYco',
              created_at: 1684442489
            }]
          }

          scope = nock('https://api.openai.com:443')
            .post(
              semver.satisfies(realVersion, '>=4.1.0') ? '/v1/fine_tuning/jobs' : '/v1/fine-tunes'
            )
            .reply(200, response, [
              'Date', 'Thu, 18 May 2023 20:41:30 GMT',
              'Content-Type', 'application/json',
              'Content-Length', '898',
              'Connection', 'close',
              'openai-version', '2020-10-01',
              'openai-processing-ms', '116'
            ])
        })

        afterEach(() => {
          nock.removeInterceptor(scope)
          scope.done()
        })

        it('makes a successful call', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', 'openai.request')
              expect(traces[0][0]).to.have.property('type', 'openai')
              if (semver.satisfies(realVersion, '>=4.1.0') && DD_MAJOR < 6) {
                expect(traces[0][0]).to.have.property('resource', 'fine_tuning.jobs.create')
              } else if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                expect(traces[0][0]).to.have.property('resource', 'fine-tune.create')
              } else {
                expect(traces[0][0]).to.have.property('resource', 'createFineTune')
              }
              expect(traces[0][0]).to.have.property('error', 0)
              expect(traces[0][0].meta).to.have.property('openai.organization.id', 'org-COOLORG') // no name just id
              expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')
              if (semver.satisfies(realVersion, '>=4.1.0')) {
                expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/fine_tuning/jobs')
              } else {
                expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/fine-tunes')
              }

              expect(traces[0][0].meta).to.have.property('openai.request.classification_positive_class', 'wat')
              expect(traces[0][0].meta).to.have.property('openai.request.model', 'curie')
              expect(traces[0][0].meta).to.have.property('openai.request.suffix', 'deleteme')
              expect(traces[0][0].meta).to.have.property('openai.request.training_file',
                'file-t3k1gVSQDHrfZnPckzftlZ4A')
              expect(traces[0][0].meta).to.have.property('openai.request.validation_file', 'file-foobar')
              expect(traces[0][0].meta).to.have.property('openai.response.fine_tuned_model', 'huh')
              expect(traces[0][0].meta).to.have.property('openai.response.id', 'ft-10RCfqSvgyEcauomw7VpiYco')
              expect(traces[0][0].meta).to.have.property('openai.response.model', 'curie')
              expect(traces[0][0].meta).to.have.property('openai.response.status', 'pending')
              expect(traces[0][0].metrics).to.have.property('openai.request.batch_size', 3)
              expect(traces[0][0].metrics).to.have.property('openai.request.classification_betas_count', 3)
              expect(traces[0][0].metrics).to.have.property('openai.request.classification_n_classes', 1)
              expect(traces[0][0].metrics).to.have.property('openai.request.compute_classification_metrics', 0)
              expect(traces[0][0].metrics).to.have.property('openai.request.learning_rate_multiplier', 0.1)
              expect(traces[0][0].metrics).to.have.property('openai.request.n_epochs', 4)
              expect(traces[0][0].metrics).to.have.property('openai.request.prompt_loss_weight', 0.01)
              expect(traces[0][0].metrics).to.have.property('openai.response.created_at', 1684442489)

              const hyperparams = semver.satisfies(realVersion, '>=4.1.0') ? 'hyperparameters' : 'hyperparams'

              if (semver.satisfies(realVersion, '<4.1.0')) {
                expect(traces[0][0].metrics).to.have.property('openai.response.events_count', 1)
              }
              expect(traces[0][0].metrics).to.have.property(`openai.response.${hyperparams}.batch_size`, 3)
              expect(traces[0][0].metrics)
                .to.have.property(`openai.response.${hyperparams}.learning_rate_multiplier`, 0.1)
              expect(traces[0][0].metrics).to.have.property(`openai.response.${hyperparams}.n_epochs`, 5)
              expect(traces[0][0].metrics).to.have.property(`openai.response.${hyperparams}.prompt_loss_weight`, 0.01)
              expect(traces[0][0].metrics).to.have.property('openai.response.result_files_count', 0)
              expect(traces[0][0].metrics).to.have.property('openai.response.training_files_count', 1)
              expect(traces[0][0].metrics).to.have.property('openai.response.updated_at', 1684442489)
              if (semver.satisfies(realVersion, '<4.1.0')) {
                expect(traces[0][0].metrics).to.have.property('openai.response.validation_files_count', 0)
              }
            })

          // only certain request parameter combinations are allowed, leaving unused ones commented for now
          const params = {
            training_file: 'file-t3k1gVSQDHrfZnPckzftlZ4A',
            validation_file: 'file-foobar',
            model: 'curie',
            n_epochs: 4,
            batch_size: 3,
            learning_rate_multiplier: 0.1,
            prompt_loss_weight: 0.01,
            compute_classification_metrics: false,
            suffix: 'deleteme',
            classification_n_classes: 1,
            classification_positive_class: 'wat',
            classification_betas: [0.1, 0.2, 0.3]
            // validation_file: '',
          }

          if (semver.satisfies(realVersion, '>=4.1.0')) {
            const result = await openai.fineTuning.jobs.create(params)

            expect(result.id).to.eql('ft-10RCfqSvgyEcauomw7VpiYco')
          } else if (semver.satisfies(realVersion, '>=4.0.0')) {
            const result = await openai.fineTunes.create(params)

            expect(result.id).to.eql('ft-10RCfqSvgyEcauomw7VpiYco')
          } else {
            const result = await openai.createFineTune(params)

            expect(result.data.id).to.eql('ft-10RCfqSvgyEcauomw7VpiYco')
          }

          await checkTraces
        })

        it('does not throw when missing classification betas', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', 'openai.request')
            })

          if (semver.satisfies(realVersion, '>=4.1.0')) {
            await openai.fineTuning.jobs.create({
              classification_betas: null
            })
          } else if (semver.satisfies(realVersion, '>=4.0.0')) {
            await openai.fineTunes.create({
              classification_betas: null
            })
          } else {
            await openai.createFineTune({
              classification_betas: null
            })
          }

          await checkTraces
        })
      })

      describe('retrieve finetune', () => {
        let scope

        beforeEach(() => {
          const response = {
            id: 'ft-10RCfqSvgyEcauomw7VpiYco',
            organization_id: 'org-COOLORG',
            model: 'curie',
            created_at: 1684442489,
            updated_at: 1684442697,
            status: 'succeeded',
            fine_tuned_model: 'curie:ft-foo:deleteme-2023-05-18-20-44-56'
          }

          if (semver.satisfies(realVersion, '>=4.1.0')) {
            response.object = 'fine_tuning.job'
            response.hyperparameters = {
              n_epochs: 4,
              batch_size: 3,
              prompt_loss_weight: 0.01,
              learning_rate_multiplier: 0.1
            }
            response.result_files = [
              'file-bJyf8TM0jeSZueBo4jpodZVQ'
            ]
            response.validation_file = null
            response.training_file = 'file-t3k1gVSQDHrfZnPckzftlZ4A'
          } else {
            response.object = 'fine-tune'
            response.hyperparams = {
              n_epochs: 4,
              batch_size: 3,
              prompt_loss_weight: 0.01,
              learning_rate_multiplier: 0.1
            }
            response.result_files = [
              {
                object: 'file',
                id: 'file-bJyf8TM0jeSZueBo4jpodZVQ',
                purpose: 'fine-tune-results',
                filename: 'compiled_results.csv',
                bytes: 410,
                created_at: 1684442697,
                status: 'processed',
                status_details: null
              }
            ]
            response.validation_files = []
            response.training_files = [{
              object: 'file',
              id: 'file-t3k1gVSQDHrfZnPckzftlZ4A',
              purpose: 'fine-tune',
              filename: 'dave-hal.jsonl',
              bytes: 356,
              created_at: 1684365950,
              status: 'processed',
              status_details: null
            }]
            response.events = [
              {
                object: 'fine-tune-event',
                level: 'info',
                message: 'Created fine-tune: ft-10RCfqSvgyEcauomw7VpiYco',
                created_at: 1684442489
              },
              {
                object: 'fine-tune-event',
                level: 'info',
                message: 'Fine-tune costs $0.00',
                created_at: 1684442612
              },
              {
                object: 'fine-tune-event',
                level: 'info',
                message: 'Fine-tune enqueued. Queue number: 0',
                created_at: 1684442612
              },
              {
                object: 'fine-tune-event',
                level: 'info',
                message: 'Fine-tune started',
                created_at: 1684442614
              },
              {
                object: 'fine-tune-event',
                level: 'info',
                message: 'Completed epoch 1/4',
                created_at: 1684442677
              },
              {
                object: 'fine-tune-event',
                level: 'info',
                message: 'Completed epoch 2/4',
                created_at: 1684442677
              },
              {
                object: 'fine-tune-event',
                level: 'info',
                message: 'Completed epoch 3/4',
                created_at: 1684442678
              },
              {
                object: 'fine-tune-event',
                level: 'info',
                message: 'Completed epoch 4/4',
                created_at: 1684442679
              },
              {
                object: 'fine-tune-event',
                level: 'info',
                message: 'Uploaded model: curie:ft-foo:deleteme-2023-05-18-20-44-56',
                created_at: 1684442696
              },
              {
                object: 'fine-tune-event',
                level: 'info',
                message: 'Uploaded result file: file-bJyf8TM0jeSZueBo4jpodZVQ',
                created_at: 1684442697
              },
              {
                object: 'fine-tune-event',
                level: 'info',
                message: 'Fine-tune succeeded',
                created_at: 1684442697
              }
            ]
          }

          scope = nock('https://api.openai.com:443')
            .get(
              semver.satisfies(realVersion, '>=4.1.0')
                ? '/v1/fine_tuning/jobs/ft-10RCfqSvgyEcauomw7VpiYco'
                : '/v1/fine-tunes/ft-10RCfqSvgyEcauomw7VpiYco'
            )
            .reply(200, response, [
              'Date', 'Thu, 18 May 2023 22:11:53 GMT',
              'Content-Type', 'application/json',
              'Content-Length', '2727',
              'Connection', 'close',
              'openai-version', '2020-10-01',
              'openai-processing-ms', '51'
            ])
        })

        after(() => {
          nock.removeInterceptor(scope)
          scope.done()
        })

        it('makes a successful call', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', 'openai.request')
              expect(traces[0][0]).to.have.property('type', 'openai')
              if (semver.satisfies(realVersion, '>=4.1.0') && DD_MAJOR < 6) {
                expect(traces[0][0]).to.have.property('resource', 'fine_tuning.jobs.retrieve')
              } else if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                expect(traces[0][0]).to.have.property('resource', 'fine-tune.retrieve')
              } else {
                expect(traces[0][0]).to.have.property('resource', 'retrieveFineTune')
              }
              expect(traces[0][0]).to.have.property('error', 0)
              expect(traces[0][0].meta).to.have.property('openai.organization.id', 'org-COOLORG') // no name just id
              expect(traces[0][0].meta).to.have.property('openai.request.method', 'GET')
              if (semver.satisfies(realVersion, '>=4.1.0')) {
                expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/fine_tuning/jobs/*')
              } else {
                expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/fine-tunes/*')
              }

              expect(traces[0][0].meta).to.have.property('openai.request.fine_tune_id', 'ft-10RCfqSvgyEcauomw7VpiYco')
              expect(traces[0][0].meta).to.have.property('openai.response.id', 'ft-10RCfqSvgyEcauomw7VpiYco')
              expect(traces[0][0].meta).to.have.property('openai.response.model', 'curie')
              expect(traces[0][0].meta).to.have.property('openai.response.status', 'succeeded')
              expect(traces[0][0].metrics).to.have.property('openai.response.created_at', 1684442489)
              if (semver.satisfies(realVersion, '<4.1.0')) {
                expect(traces[0][0].metrics).to.have.property('openai.response.events_count', 11)
              }

              const hyperparamsKey = semver.satisfies(realVersion, '>=4.1.0') ? 'hyperparameters' : 'hyperparams'

              expect(traces[0][0].metrics).to.have.property(`openai.response.${hyperparamsKey}.batch_size`, 3)
              expect(traces[0][0].metrics)
                .to.have.property(`openai.response.${hyperparamsKey}.learning_rate_multiplier`, 0.1)
              expect(traces[0][0].metrics).to.have.property(`openai.response.${hyperparamsKey}.n_epochs`, 4)
              expect(traces[0][0].metrics)
                .to.have.property(`openai.response.${hyperparamsKey}.prompt_loss_weight`, 0.01)
              expect(traces[0][0].metrics).to.have.property('openai.response.result_files_count', 1)
              expect(traces[0][0].metrics).to.have.property('openai.response.training_files_count', 1)
              expect(traces[0][0].metrics).to.have.property('openai.response.updated_at', 1684442697)
              if (semver.satisfies(realVersion, '<4.1.0')) {
                expect(traces[0][0].metrics).to.have.property('openai.response.validation_files_count', 0)
              }
            })

          if (semver.satisfies(realVersion, '>=4.1.0')) {
            const result = await openai.fineTuning.jobs.retrieve('ft-10RCfqSvgyEcauomw7VpiYco')

            expect(result.id).to.eql('ft-10RCfqSvgyEcauomw7VpiYco')
          } else if (semver.satisfies(realVersion, '>=4.0.0')) {
            const result = await openai.fineTunes.retrieve('ft-10RCfqSvgyEcauomw7VpiYco')

            expect(result.id).to.eql('ft-10RCfqSvgyEcauomw7VpiYco')
          } else {
            const result = await openai.retrieveFineTune('ft-10RCfqSvgyEcauomw7VpiYco')

            expect(result.data.id).to.eql('ft-10RCfqSvgyEcauomw7VpiYco')
          }

          await checkTraces
        })
      })

      describe('list finetunes', () => {
        let scope

        beforeEach(() => {
          const response = {
            object: 'list'
          }

          if (semver.satisfies(realVersion, '>=4.1.0')) {
            response.data = [{
              object: 'fine-tuning.jobs',
              id: 'ft-10RCfqSvgyEcauomw7VpiYco',
              hyperparameters: {
                n_epochs: 4,
                batch_size: 3,
                prompt_loss_weight: 0.01,
                learning_rate_multiplier: 0.1
              },
              created_at: 1684442489,
              updated_at: 1684442697,
              organization_id: 'org-COOLORG',
              model: 'curie',
              fine_tuned_model: 'curie:ft-foo:deleteme-2023-05-18-20-44-56',
              result_files: [],
              status: 'succeeded',
              validation_file: null,
              training_file: 'file-t3k1gVSQDHrfZnPckzftlZ4A'
            }]
          } else {
            response.data = [{
              object: 'fine-tune',
              id: 'ft-10RCfqSvgyEcauomw7VpiYco',
              hyperparams: {
                n_epochs: 4,
                batch_size: 3,
                prompt_loss_weight: 0.01,
                learning_rate_multiplier: 0.1
              },
              organization_id: 'org-COOLORG',
              model: 'curie',
              training_files: [{
                object: 'file',
                id: 'file-t3k1gVSQDHrfZnPckzftlZ4A',
                purpose: 'fine-tune',
                filename: 'dave-hal.jsonl',
                bytes: 356,
                created_at: 1684365950,
                status: 'processed',
                status_details: null
              }],
              validation_files: [],
              result_files: [{
                object: 'file',
                id: 'file-bJyf8TM0jeSZueBo4jpodZVQ',
                purpose: 'fine-tune-results',
                filename: 'compiled_results.csv',
                bytes: 410,
                created_at: 1684442697,
                status: 'processed',
                status_details: null
              }],
              created_at: 1684442489,
              updated_at: 1684442697,
              status: 'succeeded',
              fine_tuned_model: 'curie:ft-foo:deleteme-2023-05-18-20-44-56'
            }]
          }

          scope = nock('https://api.openai.com:443')
            .get(
              semver.satisfies(realVersion, '>=4.1.0')
                ? '/v1/fine_tuning/jobs'
                : '/v1/fine-tunes'
            )
            .reply(200, response)
        })

        afterEach(() => {
          nock.removeInterceptor(scope)
          scope.done()
        })

        it('makes a successful call', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', 'openai.request')
              expect(traces[0][0]).to.have.property('type', 'openai')
              if (semver.satisfies(realVersion, '>=4.1.0') && DD_MAJOR < 6) {
                expect(traces[0][0]).to.have.property('resource', 'fine_tuning.jobs.list')
              } else if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                expect(traces[0][0]).to.have.property('resource', 'fine-tune.list')
              } else {
                expect(traces[0][0]).to.have.property('resource', 'listFineTunes')
              }
              expect(traces[0][0]).to.have.property('error', 0)
              expect(traces[0][0].meta).to.have.property('openai.request.method', 'GET')
              if (semver.satisfies(realVersion, '>=4.1.0')) {
                expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/fine_tuning/jobs')
              } else {
                expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/fine-tunes')
              }

              expect(traces[0][0].metrics).to.have.property('openai.response.count', 1)
            })

          if (semver.satisfies(realVersion, '>=4.1.0')) {
            const result = await openai.fineTuning.jobs.list()

            expect(result.body.object).to.eql('list')
          } else if (semver.satisfies(realVersion, '>=4.0.0')) {
            const result = await openai.fineTunes.list()

            expect(result.object).to.eql('list')
          } else {
            const result = await openai.listFineTunes()

            expect(result.data.object).to.eql('list')
          }

          await checkTraces
        })
      })

      describe('list finetune events', () => {
        let scope

        beforeEach(() => { // beforeEach allows realVersion to be set first before nocking the call
          const response = {
            object: 'list',
            data: [
              {
                level: 'info',
                message: 'Created fine-tune: ft-10RCfqSvgyEcauomw7VpiYco',
                created_at: 1684442489
              },
              {
                level: 'info',
                message: 'Fine-tune costs $0.00',
                created_at: 1684442612
              },
              {
                level: 'info',
                message: 'Fine-tune enqueued. Queue number: 0',
                created_at: 1684442612
              },
              {
                level: 'info',
                message: 'Fine-tune started',
                created_at: 1684442614
              },
              {
                level: 'info',
                message: 'Completed epoch 1/4',
                created_at: 1684442677
              },
              {
                level: 'info',
                message: 'Completed epoch 2/4',
                created_at: 1684442677
              },
              {
                level: 'info',
                message: 'Completed epoch 3/4',
                created_at: 1684442678
              },
              {
                level: 'info',
                message: 'Completed epoch 4/4',
                created_at: 1684442679
              },
              {
                level: 'info',
                message: 'Uploaded model: curie:ft-foo:deleteme-2023-05-18-20-44-56',
                created_at: 1684442696
              },
              {
                level: 'info',
                message: 'Uploaded result file: file-bJyf8TM0jeSZueBo4jpodZVQ',
                created_at: 1684442697
              },
              {
                level: 'info',
                message: 'Fine-tune succeeded',
                created_at: 1684442697
              }
            ]
          }

          for (const event of response.data) {
            if (semver.satisfies(realVersion, '>=4.1.0')) {
              event.object = 'fine_tuning.job.event'
            } else {
              event.object = 'fine-tune-event'
            }
          }

          scope = nock('https://api.openai.com:443')
            .get(
              semver.satisfies(realVersion, '>=4.1.0')
                ? '/v1/fine_tuning/jobs/ft-10RCfqSvgyEcauomw7VpiYco/events'
                : '/v1/fine-tunes/ft-10RCfqSvgyEcauomw7VpiYco/events'
            )
            .reply(200, response, [
              'Date', 'Thu, 18 May 2023 22:47:17 GMT',
              'Content-Type', 'application/json',
              'Content-Length', '1718',
              'Connection', 'close',
              'openai-version', '2020-10-01',
              'openai-processing-ms', '33'
            ])
        })

        afterEach(() => {
          nock.removeInterceptor(scope)
          scope.done()
        })

        it('makes a successful call', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', 'openai.request')
              expect(traces[0][0]).to.have.property('type', 'openai')
              if (semver.satisfies(realVersion, '>=4.1.0') && DD_MAJOR < 6) {
                expect(traces[0][0]).to.have.property('resource', 'fine_tuning.jobs.listEvents')
              } else if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                expect(traces[0][0]).to.have.property('resource', 'fine-tune.listEvents')
              } else {
                expect(traces[0][0]).to.have.property('resource', 'listFineTuneEvents')
              }
              expect(traces[0][0]).to.have.property('error', 0)
              expect(traces[0][0].meta).to.have.property('openai.request.method', 'GET')
              if (semver.satisfies(realVersion, '>=4.1.0')) {
                expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/fine_tuning/jobs/*/events')
              } else {
                expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/fine-tunes/*/events')
              }

              expect(traces[0][0].meta).to.have.property('openai.request.fine_tune_id', 'ft-10RCfqSvgyEcauomw7VpiYco')
              expect(traces[0][0].metrics).to.have.property('openai.response.count', 11)
            })

          if (semver.satisfies(realVersion, '>=4.1.0')) {
            const result = await openai.fineTuning.jobs.listEvents('ft-10RCfqSvgyEcauomw7VpiYco')

            expect(result.body.object).to.eql('list')
          } else if (semver.satisfies(realVersion, '>=4.0.0')) {
            const result = await openai.fineTunes.listEvents('ft-10RCfqSvgyEcauomw7VpiYco')

            expect(result.object).to.eql('list')
          } else {
            const result = await openai.listFineTuneEvents('ft-10RCfqSvgyEcauomw7VpiYco')

            expect(result.data.object).to.eql('list')
          }

          await checkTraces
        })
      })

      describe('delete model', () => {
        let scope

        before(() => {
          scope = nock('https://api.openai.com:443')
            .delete('/v1/models/ft-10RCfqSvgyEcauomw7VpiYco')
            .reply(200, { // guessing on response format here since my key lacks permissions
              object: 'model',
              id: 'ft-10RCfqSvgyEcauomw7VpiYco',
              deleted: true
            }, [
              'Date', 'Thu, 18 May 2023 22:59:08 GMT',
              'Content-Type', 'application/json',
              'Content-Length', '152',
              'Connection', 'close',
              'access-control-allow-origin', '*',
              'openai-version', '2020-10-01',
              'openai-processing-ms', '23'
            ])
        })

        after(() => {
          nock.removeInterceptor(scope)
          scope.done()
        })

        it('makes a successful call', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', 'openai.request')
              expect(traces[0][0]).to.have.property('type', 'openai')
              if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                expect(traces[0][0]).to.have.property('resource', 'models.del')
              } else {
                expect(traces[0][0]).to.have.property('resource', 'deleteModel')
              }
              expect(traces[0][0]).to.have.property('error', 0)
              expect(traces[0][0].meta).to.have.property('openai.request.method', 'DELETE')
              expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/models/*')

              expect(traces[0][0].meta).to.have.property('openai.request.fine_tune_id', 'ft-10RCfqSvgyEcauomw7VpiYco')
              expect(traces[0][0].metrics).to.have.property('openai.response.deleted', 1)
              expect(traces[0][0].meta).to.have.property('openai.response.id', 'ft-10RCfqSvgyEcauomw7VpiYco')
            })

          if (semver.satisfies(realVersion, '>=4.0.0')) {
            const result = await openai.models.del('ft-10RCfqSvgyEcauomw7VpiYco')

            expect(result.deleted).to.eql(true)
          } else {
            const result = await openai.deleteModel('ft-10RCfqSvgyEcauomw7VpiYco')

            expect(result.data.deleted).to.eql(true)
          }

          await checkTraces
        })
      })

      describe('cancel finetune', () => {
        let scope

        beforeEach(() => {
          const response = {
            id: 'ft-TVpNqwlvermMegfRVqSOyPyS',
            organization_id: 'org-COOLORG',
            model: 'curie',
            created_at: 1684452102,
            updated_at: 1684452103,
            status: 'cancelled',
            fine_tuned_model: 'idk'
          }

          if (semver.satisfies(realVersion, '>=4.1.0')) {
            response.object = 'fine-tuning.job'
            response.hyperparameters = {
              n_epochs: 4,
              batch_size: 3,
              prompt_loss_weight: 0.01,
              learning_rate_multiplier: 0.1
            }
            response.training_files = 'file-t3k1gVSQDHrfZnPckzftlZ4A'
            response.validation_file = null
            response.result_files = []
          } else {
            response.object = 'fine-tune'
            response.hyperparams = {
              n_epochs: 4,
              batch_size: 3,
              prompt_loss_weight: 0.01,
              learning_rate_multiplier: 0.1
            }
            response.training_files = [{
              object: 'file',
              id: 'file-t3k1gVSQDHrfZnPckzftlZ4A',
              purpose: 'fine-tune',
              filename: 'dave-hal.jsonl',
              bytes: 356,
              created_at: 1684365950,
              status: 'processed',
              status_details: null
            }]
            response.validation_files = []
            response.result_files = []
            response.events = [
              {
                object: 'fine-tune-event',
                level: 'info',
                message: 'Created fine-tune: ft-TVpNqwlvermMegfRVqSOyPyS',
                created_at: 1684452102
              },
              {
                object: 'fine-tune-event',
                level: 'info',
                message: 'Fine-tune cancelled',
                created_at: 1684452103
              }
            ]
          }

          scope = nock('https://api.openai.com:443')
            .post(
              semver.satisfies(realVersion, '>=4.1.0')
                ? '/v1/fine_tuning/jobs/ft-TVpNqwlvermMegfRVqSOyPyS/cancel'
                : '/v1/fine-tunes/ft-TVpNqwlvermMegfRVqSOyPyS/cancel'
            )
            .reply(200, response, [
              'Date', 'Thu, 18 May 2023 23:21:43 GMT',
              'Content-Type', 'application/json',
              'Content-Length', '1042',
              'Connection', 'close',
              'openai-version', '2020-10-01',
              'openai-processing-ms', '78'
            ])
        })

        afterEach(() => {
          nock.removeInterceptor(scope)
          scope.done()
        })

        it('makes a successful call', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', 'openai.request')
              expect(traces[0][0]).to.have.property('type', 'openai')
              if (semver.satisfies(realVersion, '>=4.1.0') && DD_MAJOR < 6) {
                expect(traces[0][0]).to.have.property('resource', 'fine_tuning.jobs.cancel')
              } else if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                expect(traces[0][0]).to.have.property('resource', 'fine-tune.cancel')
              } else {
                expect(traces[0][0]).to.have.property('resource', 'cancelFineTune')
              }
              expect(traces[0][0]).to.have.property('error', 0)
              expect(traces[0][0].meta).to.have.property('openai.organization.id', 'org-COOLORG')
              expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')
              if (semver.satisfies(realVersion, '>=4.1.0')) {
                expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/fine_tuning/jobs/*/cancel')
              } else {
                expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/fine-tunes/*/cancel')
              }

              expect(traces[0][0].meta).to.have.property('openai.request.fine_tune_id', 'ft-TVpNqwlvermMegfRVqSOyPyS')
              expect(traces[0][0].meta).to.have.property('openai.response.fine_tuned_model', 'idk')
              expect(traces[0][0].meta).to.have.property('openai.response.id', 'ft-TVpNqwlvermMegfRVqSOyPyS')
              expect(traces[0][0].meta).to.have.property('openai.response.model', 'curie')
              expect(traces[0][0].meta).to.have.property('openai.response.status', 'cancelled')
              expect(traces[0][0].metrics).to.have.property('openai.response.created_at', 1684452102)
              if (semver.satisfies(realVersion, '<4.1.0')) {
                expect(traces[0][0].metrics).to.have.property('openai.response.events_count', 2)
              }

              const hyperparamsKey = semver.satisfies(realVersion, '>=4.1.0') ? 'hyperparameters' : 'hyperparams'

              expect(traces[0][0].metrics).to.have.property(`openai.response.${hyperparamsKey}.batch_size`, 3)
              expect(traces[0][0].metrics)
                .to.have.property(`openai.response.${hyperparamsKey}.learning_rate_multiplier`, 0.1)
              expect(traces[0][0].metrics).to.have.property(`openai.response.${hyperparamsKey}.n_epochs`, 4)
              expect(traces[0][0].metrics)
                .to.have.property(`openai.response.${hyperparamsKey}.prompt_loss_weight`, 0.01)
              expect(traces[0][0].metrics).to.have.property('openai.response.result_files_count', 0)
              expect(traces[0][0].metrics).to.have.property('openai.response.training_files_count', 1)
              expect(traces[0][0].metrics).to.have.property('openai.response.updated_at', 1684452103)
              if (semver.satisfies(realVersion, '<4.1.0')) {
                expect(traces[0][0].metrics).to.have.property('openai.response.validation_files_count', 0)
              }
            })

          if (semver.satisfies(realVersion, '>=4.1.0')) {
            const result = await openai.fineTuning.jobs.cancel('ft-TVpNqwlvermMegfRVqSOyPyS')

            expect(result.id).to.eql('ft-TVpNqwlvermMegfRVqSOyPyS')
          } else if (semver.satisfies(realVersion, '>=4.0.0')) {
            const result = await openai.fineTunes.cancel('ft-TVpNqwlvermMegfRVqSOyPyS')

            expect(result.id).to.eql('ft-TVpNqwlvermMegfRVqSOyPyS')
          } else {
            const result = await openai.cancelFineTune('ft-TVpNqwlvermMegfRVqSOyPyS')

            expect(result.data.id).to.eql('ft-TVpNqwlvermMegfRVqSOyPyS')
          }

          await checkTraces
        })
      })

      if (semver.intersects(version, '>=3.0.1')) {
        describe('create moderation', () => {
          let scope

          before(() => {
            scope = nock('https://api.openai.com:443')
              .post('/v1/moderations')
              .reply(200, {
                id: 'modr-7HHZZZylF31ahuhmH279JrKbGTHCW',
                model: 'text-moderation-001',
                results: [{
                  flagged: true,
                  categories: {
                    sexual: false,
                    hate: false,
                    violence: true,
                    'self-harm': false,
                    'sexual/minors': false,
                    'hate/threatening': false,
                    'violence/graphic': false
                  },
                  category_scores: {
                    sexual: 0.0018438849,
                    hate: 0.069274776,
                    violence: 0.74101615,
                    'self-harm': 0.008981651,
                    'sexual/minors': 0.00070737937,
                    'hate/threatening': 0.045174375,
                    'violence/graphic': 0.019271193
                  }
                }]
              }, [
                'Date', 'Wed, 17 May 2023 19:58:01 GMT',
                'Content-Type', 'application/json',
                'Content-Length', '450',
                'Connection', 'close',
                'openai-version', '2020-10-01',
                'openai-organization', 'kill-9',
                'openai-processing-ms', '419'
              ])
          })

          after(() => {
            nock.removeInterceptor(scope)
            scope.done()
          })

          it('makes a successful call', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('name', 'openai.request')
                expect(traces[0][0]).to.have.property('type', 'openai')
                if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                  expect(traces[0][0]).to.have.property('resource', 'moderations.create')
                } else {
                  expect(traces[0][0]).to.have.property('resource', 'createModeration')
                }
                expect(traces[0][0]).to.have.property('error', 0)
                expect(traces[0][0].meta).to.have.property('openai.organization.name', 'kill-9')
                expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')
                expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/moderations')

                expect(traces[0][0].meta).to.have.property('openai.request.input', 'I want to harm the robots')
                expect(traces[0][0].meta).to.have.property('openai.request.model', 'text-moderation-stable')
                expect(traces[0][0].meta).to.have.property('openai.response.id', 'modr-7HHZZZylF31ahuhmH279JrKbGTHCW')
                expect(traces[0][0].meta).to.have.property('openai.response.model', 'text-moderation-001')
                expect(traces[0][0].metrics).to.have.property('openai.response.categories.sexual', 0)
                expect(traces[0][0].metrics).to.have.property('openai.response.categories.hate', 0)
                expect(traces[0][0].metrics).to.have.property('openai.response.categories.violence', 1)
                expect(traces[0][0].metrics).to.have.property('openai.response.categories.self-harm', 0)
                expect(traces[0][0].metrics).to.have.property('openai.response.categories.sexual/minors', 0)
                expect(traces[0][0].metrics).to.have.property('openai.response.categories.hate/threatening', 0)
                expect(traces[0][0].metrics).to.have.property('openai.response.categories.violence/graphic', 0)
                expect(traces[0][0].metrics).to.have.property('openai.response.category_scores.hate', 0.069274776)
                expect(traces[0][0].metrics).to.have.property('openai.response.category_scores.violence', 0.74101615)
                expect(traces[0][0].metrics).to.have.property('openai.response.category_scores.sexual', 0.0018438849)
                expect(traces[0][0].metrics).to.have.property('openai.response.category_scores.hate', 0.069274776)
                expect(traces[0][0].metrics).to.have.property('openai.response.category_scores.violence', 0.74101615)
                expect(traces[0][0].metrics).to.have.property('openai.response.category_scores.self-harm', 0.008981651)
                expect(traces[0][0].metrics).to.have.property('openai.response.category_scores.sexual/minors',
                  0.00070737937)
                expect(traces[0][0].metrics).to.have.property('openai.response.category_scores.hate/threatening',
                  0.045174375)
                expect(traces[0][0].metrics).to.have.property('openai.response.category_scores.violence/graphic',
                  0.019271193)
                expect(traces[0][0].metrics).to.have.property('openai.response.flagged', 1)
              })

            if (semver.satisfies(realVersion, '>=4.0.0')) {
              const result = await openai.moderations.create({
                input: 'I want to harm the robots',
                model: 'text-moderation-stable'
              })

              expect(result.results[0].flagged).to.eql(true)
            } else {
              const result = await openai.createModeration({
                input: 'I want to harm the robots',
                model: 'text-moderation-stable'
              })

              expect(result.data.results[0].flagged).to.eql(true)
            }

            await checkTraces

            expect(externalLoggerStub).to.have.been.calledWith({
              status: 'info',
              message: semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6
                ? 'sampled moderations.create'
                : 'sampled createModeration',
              input: 'I want to harm the robots'
            })
          })
        })
      }

      if (semver.intersects(version, '>=3.1')) {
        describe('create image', () => {
          let scope

          beforeEach(() => {
            scope = nock('https://api.openai.com:443')
              .post('/v1/images/generations')
              .reply(200, {
                created: 1684270747,
                data: [{
                  url: 'https://oaidalleapiprodscus.blob.core.windows.net/private/org-COOLORG/user-FOO/img-foo.png',
                  b64_json: 'foobar==='
                }]
              }, [
                'Date', 'Tue, 16 May 2023 20:59:07 GMT',
                'Content-Type', 'application/json',
                'Content-Length', '545',
                'Connection', 'close',
                'openai-version', '2020-10-01',
                'openai-organization', 'kill-9',
                'openai-processing-ms', '5085'
              ])
          })

          afterEach(() => {
            nock.removeInterceptor(scope)
            scope.done()
          })

          it('makes a successful call using a string prompt', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('name', 'openai.request')
                expect(traces[0][0]).to.have.property('type', 'openai')
                if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                  expect(traces[0][0]).to.have.property('resource', 'images.generate')
                } else {
                  expect(traces[0][0]).to.have.property('resource', 'createImage')
                }
                expect(traces[0][0]).to.have.property('error', 0)
                expect(traces[0][0].meta).to.have.property('openai.organization.name', 'kill-9')
                expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')
                expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/images/generations')

                expect(traces[0][0].meta).to.have.property('openai.request.prompt', 'A datadog wearing headphones')
                expect(traces[0][0].meta).to.have.property('openai.request.response_format', 'url')
                expect(traces[0][0].meta).to.have.property('openai.request.size', '256x256')
                expect(traces[0][0].meta).to.have.property('openai.request.user', 'hunter2')
                expect(traces[0][0].meta).to.have.property('openai.response.images.0.url',
                  'https://oaidalleapiprodscus.blob.core.windows.net/private/org-COOLORG/user-FOO/img-foo.png')
                expect(traces[0][0].meta).to.have.property('openai.response.images.0.b64_json', 'returned')
                expect(traces[0][0].metrics).to.have.property('openai.request.n', 1)
                expect(traces[0][0].metrics).to.have.property('openai.response.created', 1684270747)
                expect(traces[0][0].metrics).to.have.property('openai.response.images_count', 1)
              })

            if (semver.satisfies(realVersion, '>=4.0.0')) {
              const result = await openai.images.generate({
                prompt: 'A datadog wearing headphones',
                n: 1,
                size: '256x256',
                response_format: 'url',
                user: 'hunter2'
              })

              expect(result.data[0].url.startsWith('https://')).to.be.true
            } else {
              const result = await openai.createImage({
                prompt: 'A datadog wearing headphones',
                n: 1,
                size: '256x256',
                response_format: 'url',
                user: 'hunter2'
              })

              expect(result.data.data[0].url.startsWith('https://')).to.be.true
            }

            await checkTraces

            expect(externalLoggerStub).to.have.been.calledWith({
              status: 'info',
              message: semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6
                ? 'sampled images.generate'
                : 'sampled createImage',
              prompt: 'A datadog wearing headphones'
            })
          })

          it('makes a successful call using an array of tokens prompt', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0][0].meta).to.have.property('openai.request.prompt', '[999, 888, 777, 666, 555]')
              })

            if (semver.satisfies(realVersion, '>=4.0.0')) {
              const result = await openai.images.generate({
                prompt: [999, 888, 777, 666, 555],
                n: 1,
                size: '256x256',
                response_format: 'url',
                user: 'hunter2'
              })

              expect(result.data[0].url.startsWith('https://')).to.be.true
            } else {
              const result = await openai.createImage({
                prompt: [999, 888, 777, 666, 555],
                n: 1,
                size: '256x256',
                response_format: 'url',
                user: 'hunter2'
              })

              expect(result.data.data[0].url.startsWith('https://')).to.be.true
            }

            await checkTraces

            expect(externalLoggerStub).to.have.been.calledWith({
              status: 'info',
              message: semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6
                ? 'sampled images.generate'
                : 'sampled createImage',
              prompt: [999, 888, 777, 666, 555]
            })
          })

          it('makes a successful call using an array of string prompts', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0][0].meta).to.have.property('openai.request.prompt.0', 'foo')
                expect(traces[0][0].meta).to.have.property('openai.request.prompt.1', 'bar')
              })

            if (semver.satisfies(realVersion, '>=4.0.0')) {
              const result = await openai.images.generate({
                prompt: ['foo', 'bar'],
                n: 1,
                size: '256x256',
                response_format: 'url',
                user: 'hunter2'
              })

              expect(result.data[0].url.startsWith('https://')).to.be.true
            } else {
              const result = await openai.createImage({
                prompt: ['foo', 'bar'],
                n: 1,
                size: '256x256',
                response_format: 'url',
                user: 'hunter2'
              })

              expect(result.data.data[0].url.startsWith('https://')).to.be.true
            }

            await checkTraces

            expect(externalLoggerStub).to.have.been.calledWith({
              status: 'info',
              message: semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6
                ? 'sampled images.generate'
                : 'sampled createImage',
              prompt: ['foo', 'bar']
            })
          })

          it('makes a successful call using an array of tokens prompts', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0][0].meta).to.have.property('openai.request.prompt.0', '[111, 222, 333]')
                expect(traces[0][0].meta).to.have.property('openai.request.prompt.1', '[444, 555, 666]')
              })

            if (semver.satisfies(realVersion, '>=4.0.0')) {
              const result = await openai.images.generate({
                prompt: [[111, 222, 333], [444, 555, 666]],
                n: 1,
                size: '256x256',
                response_format: 'url',
                user: 'hunter2'
              })

              expect(result.data[0].url.startsWith('https://'))
            } else {
              const result = await openai.createImage({
                prompt: [
                  [111, 222, 333],
                  [444, 555, 666]
                ],
                n: 1,
                size: '256x256',
                response_format: 'url',
                user: 'hunter2'
              })

              expect(result.data.data[0].url.startsWith('https://')).to.be.true
            }

            await checkTraces

            expect(externalLoggerStub).to.have.been.calledWith({
              status: 'info',
              message: semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6
                ? 'sampled images.generate'
                : 'sampled createImage',
              prompt: [[111, 222, 333], [444, 555, 666]]
            })
          })
        })

        describe('create image edit', () => {
          let scope

          before(() => {
            scope = nock('https://api.openai.com:443')
              .post('/v1/images/edits')
              .reply(200, {
                created: 1684850118,
                data: [{
                  url: 'https://oaidalleapiprodscus.blob.core.windows.net/private/org-COOLORG/user-FOO/img-bar.png',
                  b64_json: 'fOoF0f='
                }]
              }, [
                'Date', 'Tue, 23 May 2023 13:55:18 GMT',
                'Content-Type', 'application/json',
                'Content-Length', '549',
                'Connection', 'close',
                'openai-version', '2020-10-01',
                'openai-organization', 'kill-9',
                'openai-processing-ms', '9901'
              ])
          })

          after(() => {
            nock.removeInterceptor(scope)
            scope.done()
          })

          it('makes a successful call', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('name', 'openai.request')
                expect(traces[0][0]).to.have.property('type', 'openai')
                if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                  expect(traces[0][0]).to.have.property('resource', 'images.edit')
                } else {
                  expect(traces[0][0]).to.have.property('resource', 'createImageEdit')
                }
                expect(traces[0][0]).to.have.property('error', 0)
                expect(traces[0][0].meta).to.have.property('openai.organization.name', 'kill-9')
                expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')
                expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/images/edits')

                expect(traces[0][0].meta).to.have.property('openai.request.mask', 'ntsc.png')
                expect(traces[0][0].meta).to.have.property('openai.request.image', 'ntsc.png')
                expect(traces[0][0].meta).to.have.property('openai.request.prompt', 'Change all red to blue')
                expect(traces[0][0].meta).to.have.property('openai.request.response_format', 'url')
                expect(traces[0][0].meta).to.have.property('openai.request.size', '256x256')
                expect(traces[0][0].meta).to.have.property('openai.request.user', 'hunter2')
                expect(traces[0][0].meta).to.have.property('openai.response.images.0.url',
                  'https://oaidalleapiprodscus.blob.core.windows.net/private/org-COOLORG/user-FOO/img-bar.png')
                expect(traces[0][0].meta).to.have.property('openai.response.images.0.b64_json', 'returned')
                expect(traces[0][0].metrics).to.have.property('openai.request.n', 1)
                expect(traces[0][0].metrics).to.have.property('openai.response.created', 1684850118)
                expect(traces[0][0].metrics).to.have.property('openai.response.images_count', 1)
              })

            if (semver.satisfies(realVersion, '>=4.0.0')) {
              const result = await openai.images.edit({
                image: fs.createReadStream(Path.join(__dirname, 'ntsc.png')),
                prompt: 'Change all red to blue',
                mask: fs.createReadStream(Path.join(__dirname, 'ntsc.png')),
                n: 1,
                size: '256x256',
                response_format: 'url',
                user: 'hunter2'
              })

              expect(result.data[0].url.startsWith('https://')).to.be.true
            } else {
              const result = await openai.createImageEdit(
                fs.createReadStream(Path.join(__dirname, 'ntsc.png')),
                'Change all red to blue',
                fs.createReadStream(Path.join(__dirname, 'ntsc.png')),
                1,
                '256x256',
                'url',
                'hunter2'
              )

              expect(result.data.data[0].url.startsWith('https://')).to.be.true
            }

            await checkTraces

            expect(externalLoggerStub).to.have.been.calledWith({
              status: 'info',
              message: semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6
                ? 'sampled images.edit'
                : 'sampled createImageEdit',
              prompt: 'Change all red to blue',
              file: 'ntsc.png',
              mask: 'ntsc.png'
            })
          })
        })

        describe('create image variation', () => {
          let scope

          before(() => {
            scope = nock('https://api.openai.com:443')
              .post('/v1/images/variations')
              .reply(200, {
                created: 1684853320,
                data: [{
                  url: 'https://oaidalleapiprodscus.blob.core.windows.net/private/org-COOLORG/user-FOO/img-soup.png',
                  b64_json: 'foo='
                }]
              }, [
                'Date', 'Tue, 23 May 2023 14:48:40 GMT',
                'Content-Type', 'application/json',
                'Content-Length', '547',
                'Connection', 'close',
                'openai-version', '2020-10-01',
                'openai-organization', 'kill-9',
                'openai-processing-ms', '8411'
              ])
          })

          after(() => {
            nock.removeInterceptor(scope)
            scope.done()
          })

          it('makes a successful call', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('name', 'openai.request')
                expect(traces[0][0]).to.have.property('type', 'openai')
                if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                  expect(traces[0][0]).to.have.property('resource', 'images.createVariation')
                } else {
                  expect(traces[0][0]).to.have.property('resource', 'createImageVariation')
                }
                expect(traces[0][0]).to.have.property('error', 0)
                expect(traces[0][0].meta).to.have.property('openai.organization.name', 'kill-9')
                expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')
                expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/images/variations')

                expect(traces[0][0].meta).to.have.property('openai.request.image', 'ntsc.png')
                expect(traces[0][0].meta).to.have.property('openai.request.response_format', 'url')
                expect(traces[0][0].meta).to.have.property('openai.request.size', '256x256')
                expect(traces[0][0].meta).to.have.property('openai.request.user', 'hunter2')
                expect(traces[0][0].meta).to.have.property('openai.response.images.0.url',
                  'https://oaidalleapiprodscus.blob.core.windows.net/private/org-COOLORG/user-FOO/img-soup.png')
                expect(traces[0][0].meta).to.have.property('openai.response.images.0.b64_json', 'returned')
                expect(traces[0][0].metrics).to.have.property('openai.request.n', 1)
                expect(traces[0][0].metrics).to.have.property('openai.response.created', 1684853320)
                expect(traces[0][0].metrics).to.have.property('openai.response.images_count', 1)
              })

            if (semver.satisfies(realVersion, '>=4.0.0')) {
              const result = await openai.images.createVariation({
                image: fs.createReadStream(Path.join(__dirname, 'ntsc.png')),
                n: 1,
                size: '256x256',
                response_format: 'url',
                user: 'hunter2'
              })

              expect(result.data[0].url.startsWith('https://')).to.be.true
            } else {
              const result = await openai.createImageVariation(
                fs.createReadStream(Path.join(__dirname, 'ntsc.png')), 1, '256x256', 'url', 'hunter2')

              expect(result.data.data[0].url.startsWith('https://')).to.be.true
            }

            await checkTraces

            expect(externalLoggerStub).to.have.been.calledWith({
              status: 'info',
              message: semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6
                ? 'sampled images.createVariation'
                : 'sampled createImageVariation',
              file: 'ntsc.png'
            })
          })
        })
      }

      if (semver.intersects('>=3.2.0', version)) {
        describe('create chat completion', () => {
          let scope

          beforeEach(() => {
            scope = nock('https://api.openai.com:443')
              .post('/v1/chat/completions')
              .reply(200, {
                id: 'chatcmpl-7GaWqyMTD9BLmkmy8SxyjUGX3KSRN',
                object: 'chat.completion',
                created: 1684188020,
                model: 'gpt-3.5-turbo-0301',
                usage: {
                  prompt_tokens: 37,
                  completion_tokens: 10,
                  total_tokens: 47
                },
                choices: [{
                  message: {
                    role: 'assistant',
                    content: "In that case, it's best to avoid peanut",
                    name: 'hunter2'
                  },
                  finish_reason: 'length',
                  index: 0
                }]
              }, [
                'Date', 'Mon, 15 May 2023 22:00:21 GMT',
                'Content-Type', 'application/json',
                'Content-Length', '327',
                'access-control-allow-origin', '*',
                'openai-model', 'gpt-3.5-turbo-0301',
                'openai-organization', 'kill-9',
                'openai-processing-ms', '713',
                'openai-version', '2020-10-01'
              ])
          })

          afterEach(() => {
            nock.removeInterceptor(scope)
            scope.done()
          })

          it('makes a successful call', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('name', 'openai.request')
                expect(traces[0][0]).to.have.property('type', 'openai')
                if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                  expect(traces[0][0]).to.have.property('resource', 'chat.completions.create')
                } else {
                  expect(traces[0][0]).to.have.property('resource', 'createChatCompletion')
                }
                expect(traces[0][0]).to.have.property('error', 0)
                expect(traces[0][0].meta).to.have.property('openai.organization.name', 'kill-9')

                expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')
                expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/chat/completions')

                expect(traces[0][0].meta).to.have.property('openai.request.messages.0.content',
                  'Peanut Butter or Jelly?')
                expect(traces[0][0].meta).to.have.property('openai.request.messages.0.name', 'hunter2')
                expect(traces[0][0].meta).to.have.property('openai.request.messages.0.role', 'user')
                expect(traces[0][0].meta).to.have.property('openai.request.messages.1.content',
                  'Are you allergic to peanuts?')
                expect(traces[0][0].meta).to.have.property('openai.request.messages.1.role', 'assistant')
                expect(traces[0][0].meta).to.have.property('openai.request.messages.2.content', 'Deathly allergic!')
                expect(traces[0][0].meta).to.have.property('openai.request.messages.2.role', 'user')
                expect(traces[0][0].meta).to.have.property('openai.request.model', 'gpt-3.5-turbo')
                expect(traces[0][0].meta).to.have.property('openai.request.stop', 'time')
                expect(traces[0][0].meta).to.have.property('openai.request.user', 'hunter2')
                expect(traces[0][0].meta).to.have.property('openai.response.choices.0.finish_reason', 'length')
                expect(traces[0][0].meta).to.have.property('openai.response.choices.0.message.content',
                  "In that case, it's best to avoid peanut")
                expect(traces[0][0].meta).to.have.property('openai.response.choices.0.message.role', 'assistant')
                expect(traces[0][0].meta).to.have.property('openai.response.choices.0.message.name', 'hunter2')
                expect(traces[0][0].meta).to.have.property('openai.response.model', 'gpt-3.5-turbo-0301')
                expect(traces[0][0].metrics).to.have.property('openai.request.logit_bias.1234', -1)
                expect(traces[0][0].metrics).to.have.property('openai.request.max_tokens', 10)
                expect(traces[0][0].metrics).to.have.property('openai.request.n', 3)
                expect(traces[0][0].metrics).to.have.property('openai.request.presence_penalty', -0.0001)
                expect(traces[0][0].metrics).to.have.property('openai.request.temperature', 1.001)
                expect(traces[0][0].metrics).to.have.property('openai.request.top_p', 4)
                expect(traces[0][0].metrics).to.have.property('openai.response.usage.completion_tokens', 10)
                expect(traces[0][0].metrics).to.have.property('openai.response.usage.prompt_tokens', 37)
                expect(traces[0][0].metrics).to.have.property('openai.response.usage.total_tokens', 47)
              })

            const params = {
              model: 'gpt-3.5-turbo',
              messages: [
                {
                  role: 'user',
                  content: 'Peanut Butter or Jelly?',
                  name: 'hunter2'
                },
                {
                  role: 'assistant',
                  content: 'Are you allergic to peanuts?',
                  name: 'hal'
                },
                {
                  role: 'user',
                  content: 'Deathly allergic!',
                  name: 'hunter2'
                }
              ],
              temperature: 1.001,
              stream: false,
              max_tokens: 10,
              presence_penalty: -0.0001,
              frequency_penalty: 0.0001,
              logit_bias: {
                1234: -1
              },
              top_p: 4,
              n: 3,
              stop: 'time',
              user: 'hunter2'
            }

            if (semver.satisfies(realVersion, '>=4.0.0')) {
              const prom = openai.chat.completions.create(params)
              expect(prom).to.have.property('withResponse')

              const result = await prom

              expect(result.id).to.eql('chatcmpl-7GaWqyMTD9BLmkmy8SxyjUGX3KSRN')
              expect(result.model).to.eql('gpt-3.5-turbo-0301')
              expect(result.choices[0].message.role).to.eql('assistant')
              expect(result.choices[0].message.content).to.eql('In that case, it\'s best to avoid peanut')
              expect(result.choices[0].finish_reason).to.eql('length')
            } else {
              const result = await openai.createChatCompletion(params)

              expect(result.data.id).to.eql('chatcmpl-7GaWqyMTD9BLmkmy8SxyjUGX3KSRN')
              expect(result.data.model).to.eql('gpt-3.5-turbo-0301')
              expect(result.data.choices[0].message.role).to.eql('assistant')
              expect(result.data.choices[0].message.content).to.eql('In that case, it\'s best to avoid peanut')
              expect(result.data.choices[0].finish_reason).to.eql('length')
            }

            await checkTraces

            expect(externalLoggerStub).to.have.been.calledWith({
              status: 'info',
              message:
                  semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6
                    ? 'sampled chat.completions.create'
                    : 'sampled createChatCompletion',
              messages: [
                {
                  role: 'user',
                  content: 'Peanut Butter or Jelly?',
                  name: 'hunter2'
                },
                {
                  role: 'assistant',
                  content: 'Are you allergic to peanuts?',
                  name: 'hal'
                },
                { role: 'user', content: 'Deathly allergic!', name: 'hunter2' }
              ],
              choices: [{
                message: {
                  role: 'assistant',
                  content: "In that case, it's best to avoid peanut",
                  name: 'hunter2'
                },
                finish_reason: 'length',
                index: 0
              }]
            })
          })

          it('does not error with invalid .messages or missing .logit_bias', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('name', 'openai.request')
              })

            if (semver.satisfies(realVersion, '>=4.0.0')) {
              await openai.chat.completions.create({
                model: 'gpt-3.5-turbo',
                messages: null
              })
            } else {
              await openai.createChatCompletion({
                model: 'gpt-3.5-turbo',
                messages: null
              })
            }

            await checkTraces
          })

          it('should tag image_url', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                // image_url is only relevant on request/input, output has the same shape as a normal chat completion
                expect(span.meta).to.have.property('openai.request.messages.0.content.0.type', 'text')
                expect(span.meta).to.have.property(
                  'openai.request.messages.0.content.0.text', 'I\'m allergic to peanuts. Should I avoid this food?'
                )
                expect(span.meta).to.have.property('openai.request.messages.0.content.1.type', 'image_url')
                expect(span.meta).to.have.property(
                  'openai.request.messages.0.content.1.image_url.url', 'dummy/url/peanut_food.png'
                )
              })

            const params = {
              model: 'gpt-4-visual-preview',
              messages: [
                {
                  role: 'user',
                  name: 'hunter2',
                  content: [
                    {
                      type: 'text',
                      text: 'I\'m allergic to peanuts. Should I avoid this food?'
                    },
                    {
                      type: 'image_url',
                      image_url: {
                        url: 'dummy/url/peanut_food.png'
                      }
                    }
                  ]
                }
              ]
            }

            if (semver.satisfies(realVersion, '>=4.0.0')) {
              const result = await openai.chat.completions.create(params)

              expect(result.id).to.eql('chatcmpl-7GaWqyMTD9BLmkmy8SxyjUGX3KSRN')
              expect(result.choices[0].message.role).to.eql('assistant')
              expect(result.choices[0].message.content).to.eql('In that case, it\'s best to avoid peanut')
              expect(result.choices[0].finish_reason).to.eql('length')
            } else {
              const result = await openai.createChatCompletion(params)

              expect(result.data.id).to.eql('chatcmpl-7GaWqyMTD9BLmkmy8SxyjUGX3KSRN')
              expect(result.data.choices[0].message.role).to.eql('assistant')
              expect(result.data.choices[0].message.content).to.eql('In that case, it\'s best to avoid peanut')
              expect(result.data.choices[0].finish_reason).to.eql('length')
            }

            await checkTraces
          })
        })

        describe('create chat completion with tools', () => {
          let scope

          beforeEach(() => {
            scope = nock('https://api.openai.com:443')
              .post('/v1/chat/completions')
              .reply(200, {
                id: 'chatcmpl-7GaWqyMTD9BLmkmy8SxyjUGX3KSRN',
                object: 'chat.completion',
                created: 1684188020,
                model: 'gpt-3.5-turbo-0301',
                usage: {
                  prompt_tokens: 37,
                  completion_tokens: 10,
                  total_tokens: 47
                },
                choices: [{
                  message: {
                    role: 'assistant',
                    content: null,
                    name: 'hunter2',
                    tool_calls: [
                      {
                        id: 'tool-1',
                        type: 'function',
                        function: {
                          name: 'extract_fictional_info',
                          arguments: '{"name":"SpongeBob","origin":"Bikini Bottom"}'
                        }
                      }
                    ]
                  },
                  finish_reason: 'tool_calls',
                  index: 0
                }]
              }, [
                'Date', 'Mon, 15 May 2023 22:00:21 GMT',
                'Content-Type', 'application/json',
                'Content-Length', '327',
                'access-control-allow-origin', '*',
                'openai-model', 'gpt-3.5-turbo-0301',
                'openai-organization', 'kill-9',
                'openai-processing-ms', '713',
                'openai-version', '2020-10-01'
              ])
          })

          afterEach(() => {
            nock.removeInterceptor(scope)
            scope.done()
          })

          it('tags the tool calls successfully', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0][0].meta)
                  .to.have.property('openai.response.choices.0.message.tool_calls.0.function.name',
                    'extract_fictional_info')
                expect(traces[0][0].meta)
                  .to.have.property('openai.response.choices.0.message.tool_calls.0.function.arguments',
                    '{"name":"SpongeBob","origin":"Bikini Bottom"}')
                expect(traces[0][0].meta).to.have.property('openai.response.choices.0.finish_reason', 'tool_calls')
              })

            const input = 'My name is SpongeBob and I live in Bikini Bottom.'
            const tools = [
              {
                name: 'extract_fictional_info',
                description: 'Get the fictional information from the body of the input text',
                parameters: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Name of the character' },
                    origin: { type: 'string', description: 'Where they live' }
                  }
                }
              }
            ]

            if (semver.satisfies(realVersion, '>=4.0.0')) {
              const result = await openai.chat.completions.create({
                model: 'gpt-3.5-turbo',
                messages: [{ role: 'user', content: input, name: 'hunter2' }],
                tools: [{ type: 'function', function: tools[0] }],
                tool_choice: 'auto'
              })

              expect(result.choices[0].finish_reason).to.eql('tool_calls')
            } else {
              const result = await openai.createChatCompletion({
                model: 'gpt-3.5-turbo',
                messages: [{ role: 'user', content: input, name: 'hunter2' }],
                tools: [{ type: 'function', function: tools[0] }],
                tool_choice: 'auto'
              })

              expect(result.data.choices[0].finish_reason).to.eql('tool_calls')
            }

            await checkTraces

            expect(externalLoggerStub).to.have.been.calledWith({
              status: 'info',
              message:
                  semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6
                    ? 'sampled chat.completions.create'
                    : 'sampled createChatCompletion',
              messages: [
                {
                  role: 'user',
                  content: input,
                  name: 'hunter2'
                }
              ],
              choices: [{
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'tool-1',
                      type: 'function',
                      function: {
                        name: 'extract_fictional_info',
                        arguments: '{"name":"SpongeBob","origin":"Bikini Bottom"}'
                      }
                    }
                  ],
                  name: 'hunter2'
                },
                finish_reason: 'tool_calls',
                index: 0
              }]
            })
          })
        })

        describe('create transcription', () => {
          let scope

          before(() => {
            scope = nock('https://api.openai.com:443')
              .post('/v1/audio/transcriptions')
              .reply(200, {
                task: 'transcribe',
                language: 'english',
                duration: 2.19,
                segments: [{
                  id: 0,
                  seek: 0,
                  start: 0,
                  end: 2,
                  text: ' Hello, friend.',
                  tokens: [50364, 2425, 11, 1277, 13, 50464],
                  temperature: 0.5,
                  avg_logprob: -0.7777707236153739,
                  compression_ratio: 0.6363636363636364,
                  no_speech_prob: 0.043891049921512604,
                  transient: false
                }],
                text: 'Hello, friend.'
              }, [
                'Date', 'Fri, 19 May 2023 03:19:49 GMT',
                'Content-Type', 'text/plain; charset=utf-8',
                'Content-Length', '15',
                'Connection', 'close',
                'openai-organization', 'kill-9',
                'openai-processing-ms', '595',
                'openai-version', '2020-10-01'
              ]
              )
          })

          after(() => {
            nock.removeInterceptor(scope)
            scope.done()
          })

          it('makes a successful call', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('name', 'openai.request')
                expect(traces[0][0]).to.have.property('type', 'openai')
                if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                  expect(traces[0][0]).to.have.property('resource', 'audio.transcriptions.create')
                } else {
                  expect(traces[0][0]).to.have.property('resource', 'createTranscription')
                }
                expect(traces[0][0]).to.have.property('error', 0)
                expect(traces[0][0].meta).to.have.property('openai.organization.name', 'kill-9')

                expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/audio/transcriptions')
                expect(traces[0][0].meta).to.have.property('openai.request.filename', 'hello-friend.m4a')
                expect(traces[0][0].meta).to.have.property('openai.request.language', 'en')
                expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')
                expect(traces[0][0].meta).to.have.property('openai.request.model', 'whisper-1')
                expect(traces[0][0].meta).to.have.property('openai.request.prompt', 'what does this say')
                expect(traces[0][0].meta).to.have.property('openai.request.response_format', 'verbose_json')
                expect(traces[0][0].meta).to.have.property('openai.response.language', 'english')
                expect(traces[0][0].meta).to.have.property('openai.response.text', 'Hello, friend.')
                expect(traces[0][0].metrics).to.have.property('openai.response.duration', 2.19)
                expect(traces[0][0].metrics).to.have.property('openai.response.segments_count', 1)
                expect(traces[0][0].metrics).to.have.property('openai.request.temperature', 0.5)
              })

            // TODO: Should test each of 'json, text, srt, verbose_json, vtt' since response formats differ
            if (semver.satisfies(realVersion, '>=4.0.0')) {
              const result = await openai.audio.transcriptions.create({
                file: fs.createReadStream(Path.join(__dirname, '/hello-friend.m4a')),
                model: 'whisper-1',
                prompt: 'what does this say',
                response_format: 'verbose_json',
                temperature: 0.5,
                language: 'en'
              })

              // for OpenAI v4, the result is a stringified version of the JSON response
              expect(typeof result).to.eql('string')
            } else {
              const result = await openai.createTranscription(
                fs.createReadStream(Path.join(__dirname, '/hello-friend.m4a')),
                'whisper-1',
                'what does this say',
                'verbose_json',
                0.5,
                'en'
              )

              expect(result.data.text).to.eql('Hello, friend.')
            }

            await checkTraces

            expect(externalLoggerStub).to.have.been.calledWith({
              status: 'info',
              message: semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6
                ? 'sampled audio.transcriptions.create'
                : 'sampled createTranscription',
              prompt: 'what does this say',
              file: 'hello-friend.m4a'
            })
          })
        })

        describe('create translation', () => {
          let scope

          before(() => {
            scope = nock('https://api.openai.com:443')
              .post('/v1/audio/translations')
              .reply(200, {
                task: 'translate',
                language: 'english',
                duration: 1.74,
                segments: [{
                  id: 0,
                  seek: 0,
                  start: 0,
                  end: 3,
                  text: ' Guten Tag!',
                  tokens: [50364, 42833, 11204, 0, 50514],
                  temperature: 0.5,
                  avg_logprob: -0.5626437266667684,
                  compression_ratio: 0.5555555555555556,
                  no_speech_prob: 0.01843200996518135,
                  transient: false
                }],
                text: 'Guten Tag!'
              }, [
                'Date', 'Fri, 19 May 2023 03:41:25 GMT',
                'Content-Type', 'application/json',
                'Content-Length', '334',
                'Connection', 'close',
                'openai-organization', 'kill-9',
                'openai-processing-ms', '520',
                'openai-version', '2020-10-01'
              ])
          })

          after(() => {
            nock.removeInterceptor(scope)
            scope.done()
          })

          it('makes a successful call', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('name', 'openai.request')
                expect(traces[0][0]).to.have.property('type', 'openai')
                if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                  expect(traces[0][0]).to.have.property('resource', 'audio.translations.create')
                } else {
                  expect(traces[0][0]).to.have.property('resource', 'createTranslation')
                }
                expect(traces[0][0]).to.have.property('error', 0)
                expect(traces[0][0].meta).to.have.property('openai.organization.name', 'kill-9')

                expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/audio/translations')
                expect(traces[0][0].meta).to.have.property('openai.request.filename', 'guten-tag.m4a')
                expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')
                expect(traces[0][0].meta).to.have.property('openai.request.model', 'whisper-1')
                expect(traces[0][0].meta).to.have.property('openai.request.prompt', 'greeting')
                expect(traces[0][0].meta).to.have.property('openai.request.response_format', 'verbose_json')
                expect(traces[0][0].meta).to.have.property('openai.response.language', 'english')
                expect(traces[0][0].meta).to.have.property('openai.response.text', 'Guten Tag!')
                expect(traces[0][0].metrics).to.have.property('openai.request.temperature', 0.5)
                expect(traces[0][0].metrics).to.have.property('openai.response.duration', 1.74)
                expect(traces[0][0].metrics).to.have.property('openai.response.segments_count', 1)
              })

            // TODO: Should test each of 'json, text, srt, verbose_json, vtt' since response formats differ
            if (semver.satisfies(realVersion, '>=4.0.0')) {
              const result = await openai.audio.translations.create({
                file: fs.createReadStream(Path.join(__dirname, 'guten-tag.m4a')),
                model: 'whisper-1',
                prompt: 'greeting',
                response_format: 'verbose_json',
                temperature: 0.5
              })

              expect(result.text).to.eql('Guten Tag!')
            } else {
              const result = await openai.createTranslation(
                fs.createReadStream(Path.join(__dirname, 'guten-tag.m4a')),
                'whisper-1',
                'greeting',
                'verbose_json',
                0.5
              )

              expect(result.data.text).to.eql('Guten Tag!')
            }

            await checkTraces

            expect(externalLoggerStub).to.have.been.calledWith({
              status: 'info',
              message: semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6
                ? 'sampled audio.translations.create'
                : 'sampled createTranslation',
              prompt: 'greeting',
              file: 'guten-tag.m4a'
            })
          })
        })
      }

      if (semver.intersects('>4.1.0', version)) {
        describe('streamed responses', () => {
          afterEach(() => {
            nock.cleanAll()
          })

          it('makes a successful chat completion call', async () => {
            nock('https://api.openai.com:443')
              .post('/v1/chat/completions')
              .reply(200, function () {
                return fs.createReadStream(Path.join(__dirname, 'streamed-responses/chat.completions.simple.txt'))
              }, {
                'Content-Type': 'text/plain',
                'openai-organization': 'kill-9'
              })

            const checkTraces = agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', 'openai.request')
                expect(span).to.have.property('type', 'openai')
                expect(span).to.have.property('error', 0)
                expect(span.meta).to.have.property('openai.organization.name', 'kill-9')
                expect(span.meta).to.have.property('openai.request.method', 'POST')
                expect(span.meta).to.have.property('openai.request.endpoint', '/v1/chat/completions')
                expect(span.meta).to.have.property('openai.request.model', 'gpt-4o')
                expect(span.meta).to.have.property('openai.request.messages.0.content',
                  'Hello, OpenAI!')
                expect(span.meta).to.have.property('openai.request.messages.0.role', 'user')
                expect(span.meta).to.have.property('openai.request.messages.0.name', 'hunter2')
                expect(span.meta).to.have.property('openai.response.choices.0.finish_reason', 'stop')
                expect(span.meta).to.have.property('openai.response.choices.0.logprobs', 'returned')
                expect(span.meta).to.have.property('openai.response.choices.0.message.role', 'assistant')
                expect(span.meta).to.have.property('openai.response.choices.0.message.content',
                  'Hello! How can I assist you today?')

                expect(span.metrics).to.have.property('openai.response.usage.prompt_tokens')
                expect(span.metrics).to.not.have.property('openai.response.usage.prompt_tokens_estimated')
                expect(span.metrics).to.have.property('openai.response.usage.completion_tokens')
                expect(span.metrics).to.not.have.property('openai.response.usage.completion_tokens_estimated')
                expect(span.metrics).to.have.property('openai.response.usage.total_tokens')
              })

            const stream = await openai.chat.completions.create({
              model: 'gpt-4o',
              messages: [{ role: 'user', content: 'Hello, OpenAI!', name: 'hunter2' }],
              temperature: 0.5,
              stream: true
            }, { /* request-specific options */ })

            for await (const part of stream) {
              expect(part).to.have.property('choices')
              expect(part.choices[0]).to.have.property('delta')
            }

            await checkTraces

            expect(metricStub).to.have.been.calledWith('openai.tokens.prompt')
            expect(metricStub).to.have.been.calledWith('openai.tokens.completion')
            expect(metricStub).to.have.been.calledWith('openai.tokens.total')
          })

          it('makes a successful chat completion call with empty stream', async () => {
            nock('https://api.openai.com:443')
              .post('/v1/chat/completions')
              .reply(200, function () {
                return fs.createReadStream(Path.join(__dirname, 'streamed-responses/chat.completions.empty.txt'))
              }, {
                'Content-Type': 'text/plain',
                'openai-organization': 'kill-9'
              })

            const checkTraces = agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', 'openai.request')
                expect(span).to.have.property('type', 'openai')
                expect(span).to.have.property('error', 0)
                expect(span.meta).to.have.property('openai.organization.name', 'kill-9')
                expect(span.meta).to.have.property('openai.request.method', 'POST')
                expect(span.meta).to.have.property('openai.request.endpoint', '/v1/chat/completions')
                expect(span.meta).to.have.property('openai.request.model', 'gpt-4o')
                expect(span.meta).to.have.property('openai.request.messages.0.content', 'Hello, OpenAI!')
                expect(span.meta).to.have.property('openai.request.messages.0.role', 'user')
                expect(span.meta).to.have.property('openai.request.messages.0.name', 'hunter2')
              })

            const stream = await openai.chat.completions.create({
              model: 'gpt-4o',
              messages: [{ role: 'user', content: 'Hello, OpenAI!', name: 'hunter2' }],
              temperature: 0.5,
              stream: true
            })

            for await (const part of stream) {
              expect(part).to.have.property('choices')
            }

            await checkTraces
          })

          it('makes a successful chat completion call with multiple choices', async () => {
            nock('https://api.openai.com:443')
              .post('/v1/chat/completions')
              .reply(200, function () {
                return fs.createReadStream(Path.join(__dirname, 'streamed-responses/chat.completions.multiple.txt'))
              }, {
                'Content-Type': 'text/plain',
                'openai-organization': 'kill-9'
              })

            const checkTraces = agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', 'openai.request')
                expect(span).to.have.property('type', 'openai')
                expect(span).to.have.property('error', 0)
                expect(span.meta).to.have.property('openai.organization.name', 'kill-9')
                expect(span.meta).to.have.property('openai.request.method', 'POST')
                expect(span.meta).to.have.property('openai.request.endpoint', '/v1/chat/completions')
                expect(span.meta).to.have.property('openai.request.model', 'gpt-4')
                expect(span.meta).to.have.property('openai.request.messages.0.content', 'How are you?')
                expect(span.meta).to.have.property('openai.request.messages.0.role', 'user')
                expect(span.meta).to.have.property('openai.request.messages.0.name', 'hunter2')

                // message 0
                expect(span.meta).to.have.property('openai.response.choices.0.finish_reason', 'stop')
                expect(span.meta).to.have.property('openai.response.choices.0.logprobs', 'returned')
                expect(span.meta).to.have.property('openai.response.choices.0.message.role', 'assistant')
                expect(span.meta).to.have.property('openai.response.choices.0.message.content',
                  'As an AI, I don\'t have feelings, but I\'m here to assist you. How can I help you today?'
                )

                // message 1
                expect(span.meta).to.have.property('openai.response.choices.1.finish_reason', 'stop')
                expect(span.meta).to.have.property('openai.response.choices.1.logprobs', 'returned')
                expect(span.meta).to.have.property('openai.response.choices.1.message.role', 'assistant')
                expect(span.meta).to.have.property('openai.response.choices.1.message.content',
                  'I\'m just a computer program so I don\'t have feelings, ' +
                    'but I\'m here and ready to help you with anything you need. How can I assis...'
                )

                // message 2
                expect(span.meta).to.have.property('openai.response.choices.2.finish_reason', 'stop')
                expect(span.meta).to.have.property('openai.response.choices.2.logprobs', 'returned')
                expect(span.meta).to.have.property('openai.response.choices.2.message.role', 'assistant')
                expect(span.meta).to.have.property('openai.response.choices.2.message.content',
                  'I\'m just a computer program, so I don\'t have feelings like humans do. ' +
                    'I\'m here and ready to assist you with any questions or tas...'
                )
              })

            const stream = await openai.chat.completions.create({
              model: 'gpt-4',
              messages: [{ role: 'user', content: 'How are you?', name: 'hunter2' }],
              stream: true,
              n: 3
            })

            for await (const part of stream) {
              expect(part).to.have.property('choices')
              expect(part.choices[0]).to.have.property('delta')
            }

            await checkTraces
          })

          it('makes a successful chat completion call with usage included', async () => {
            nock('https://api.openai.com:443')
              .post('/v1/chat/completions')
              .reply(200, function () {
                return fs.createReadStream(Path.join(__dirname, 'streamed-responses/chat.completions.simple.usage.txt'))
              }, {
                'Content-Type': 'text/plain',
                'openai-organization': 'kill-9'
              })

            const checkTraces = agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]

                expect(span.meta).to.have.property('openai.response.choices.0.message.content', 'I\'m just a computer')
                expect(span.metrics).to.have.property('openai.response.usage.prompt_tokens', 11)
                expect(span.metrics).to.have.property('openai.response.usage.completion_tokens', 5)
                expect(span.metrics).to.have.property('openai.response.usage.total_tokens', 16)
              })

            const stream = await openai.chat.completions.create({
              model: 'gpt-3.5-turbo',
              messages: [{ role: 'user', content: 'How are you?', name: 'hunter2' }],
              max_tokens: 5,
              stream: true,
              stream_options: {
                include_usage: true
              }
            })

            for await (const part of stream) {
              expect(part).to.have.property('choices')
            }

            await checkTraces

            const expectedTags = [
              'error:0',
              'org:kill-9',
              'endpoint:/v1/chat/completions',
              'model:gpt-3.5-turbo-0125'
            ]

            expect(metricStub).to.have.been.calledWith('openai.tokens.prompt', 11, 'd', expectedTags)
            expect(metricStub).to.have.been.calledWith('openai.tokens.completion', 5, 'd', expectedTags)
            expect(metricStub).to.have.been.calledWith('openai.tokens.total', 16, 'd', expectedTags)
          })

          it('makes a successful chat completion call without image_url usage computed', async () => {
            nock('https://api.openai.com:443')
              .post('/v1/chat/completions')
              .reply(200, function () {
                return fs.createReadStream(Path.join(__dirname, 'streamed-responses/chat.completions.simple.txt'))
              }, {
                'Content-Type': 'text/plain',
                'openai-organization': 'kill-9'
              })

            const checkTraces = agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]

                // we shouldn't be trying to capture the image_url tokens
                expect(span.metrics).to.have.property('openai.response.usage.prompt_tokens', 1)
              })

            const stream = await openai.chat.completions.create({
              stream: 1,
              model: 'gpt-4o',
              messages: [
                {
                  role: 'user',
                  name: 'hunter2',
                  content: [
                    {
                      type: 'text',
                      text: 'One' // one token, for ease of testing
                    },
                    {
                      type: 'image_url',
                      image_url: {
                        url: 'dummy/url/peanut_food.png'
                      }
                    }
                  ]
                }
              ]
            })

            for await (const part of stream) {
              expect(part).to.have.property('choices')
            }

            await checkTraces
          })

          it('makes a successful completion call', async () => {
            nock('https://api.openai.com:443')
              .post('/v1/completions')
              .reply(200, function () {
                return fs.createReadStream(Path.join(__dirname, 'streamed-responses/completions.simple.txt'))
              }, {
                'Content-Type': 'text/plain',
                'openai-organization': 'kill-9'
              })

            const checkTraces = agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]

                expect(span).to.have.property('name', 'openai.request')
                expect(span).to.have.property('type', 'openai')
                expect(span).to.have.property('error', 0)
                expect(span.meta).to.have.property('openai.organization.name', 'kill-9')
                expect(span.meta).to.have.property('openai.request.method', 'POST')
                expect(span.meta).to.have.property('openai.request.endpoint', '/v1/completions')
                expect(span.meta).to.have.property('openai.request.model', 'text-davinci-002')
                expect(span.meta).to.have.property('openai.request.prompt', 'Hello, OpenAI!')
                expect(span.meta).to.have.property('openai.response.choices.0.finish_reason', 'stop')
                expect(span.meta).to.have.property('openai.response.choices.0.logprobs', 'returned')
                expect(span.meta).to.have.property('openai.response.choices.0.text', ' this is a test.')

                expect(span.metrics).to.have.property('openai.response.usage.prompt_tokens')
                expect(span.metrics).to.not.have.property('openai.response.usage.prompt_tokens_estimated')
                expect(span.metrics).to.have.property('openai.response.usage.completion_tokens')
                expect(span.metrics).to.not.have.property('openai.response.usage.completion_tokens_estimated')
                expect(span.metrics).to.have.property('openai.response.usage.total_tokens')
              })

            const stream = await openai.completions.create({
              model: 'text-davinci-002',
              prompt: 'Hello, OpenAI!',
              temperature: 0.5,
              stream: true
            })

            for await (const part of stream) {
              expect(part).to.have.property('choices')
              expect(part.choices[0]).to.have.property('text')
            }

            await checkTraces

            expect(metricStub).to.have.been.calledWith('openai.tokens.prompt')
            expect(metricStub).to.have.been.calledWith('openai.tokens.completion')
            expect(metricStub).to.have.been.calledWith('openai.tokens.total')
          })

          it('makes a successful completion call with usage included', async () => {
            nock('https://api.openai.com:443')
              .post('/v1/completions')
              .reply(200, function () {
                return fs.createReadStream(Path.join(__dirname, 'streamed-responses/completions.simple.usage.txt'))
              }, {
                'Content-Type': 'text/plain',
                'openai-organization': 'kill-9'
              })

            const checkTraces = agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]

                expect(span.meta).to.have.property('openai.response.choices.0.text', '\\n\\nI am an AI')
                expect(span.metrics).to.have.property('openai.response.usage.prompt_tokens', 4)
                expect(span.metrics).to.have.property('openai.response.usage.completion_tokens', 5)
                expect(span.metrics).to.have.property('openai.response.usage.total_tokens', 9)
              })

            const stream = await openai.completions.create({
              model: 'gpt-3.5-turbo-instruct',
              prompt: 'How are you?',
              stream: true,
              max_tokens: 5,
              stream_options: {
                include_usage: true
              }
            })

            for await (const part of stream) {
              expect(part).to.have.property('choices')
            }

            await checkTraces

            const expectedTags = [
              'error:0',
              'org:kill-9',
              'endpoint:/v1/completions',
              'model:gpt-3.5-turbo-instruct'
            ]

            expect(metricStub).to.have.been.calledWith('openai.tokens.prompt', 4, 'd', expectedTags)
            expect(metricStub).to.have.been.calledWith('openai.tokens.completion', 5, 'd', expectedTags)
            expect(metricStub).to.have.been.calledWith('openai.tokens.total', 9, 'd', expectedTags)
          })

          if (semver.intersects('>4.16.0', version)) {
            it('makes a successful chat completion call with tools', async () => {
              nock('https://api.openai.com:443')
                .post('/v1/chat/completions')
                .reply(200, function () {
                  return fs.createReadStream(Path.join(__dirname, 'streamed-responses/chat.completions.tools.txt'))
                }, {
                  'Content-Type': 'text/plain',
                  'openai-organization': 'kill-9'
                })

              const checkTraces = agent
                .assertSomeTraces(traces => {
                  const span = traces[0][0]

                  expect(span).to.have.property('name', 'openai.request')
                  expect(span).to.have.property('type', 'openai')
                  expect(span).to.have.property('error', 0)
                  expect(span.meta).to.have.property('openai.organization.name', 'kill-9')
                  expect(span.meta).to.have.property('openai.request.method', 'POST')
                  expect(span.meta).to.have.property('openai.request.endpoint', '/v1/chat/completions')
                  expect(span.meta).to.have.property('openai.request.model', 'gpt-4')
                  expect(span.meta).to.have.property('openai.request.messages.0.content', 'Hello, OpenAI!')
                  expect(span.meta).to.have.property('openai.request.messages.0.role', 'user')
                  expect(span.meta).to.have.property('openai.request.messages.0.name', 'hunter2')
                  expect(span.meta).to.have.property('openai.response.choices.0.finish_reason', 'tool_calls')
                  expect(span.meta).to.have.property('openai.response.choices.0.logprobs', 'returned')
                  expect(span.meta).to.have.property('openai.response.choices.0.message.role', 'assistant')
                  expect(span.meta).to.have.property('openai.response.choices.0.message.tool_calls.0.function.name',
                    'get_current_weather')
                })

              const tools = [
                {
                  type: 'function',
                  function: {
                    name: 'get_current_weather',
                    description: 'Get the current weather in a given location',
                    parameters: {
                      type: 'object',
                      properties: {
                        location: {
                          type: 'string',
                          description: 'The city and state, e.g. San Francisco, CA'
                        },
                        unit: { type: 'string', enum: ['celsius', 'fahrenheit'] }
                      },
                      required: ['location']
                    }
                  }
                }
              ]

              const stream = await openai.chat.completions.create({
                model: 'gpt-4',
                messages: [{ role: 'user', content: 'Hello, OpenAI!', name: 'hunter2' }],
                temperature: 0.5,
                tools,
                tool_choice: 'auto',
                stream: true
              })

              for await (const part of stream) {
                expect(part).to.have.property('choices')
                expect(part.choices[0]).to.have.property('delta')
              }

              await checkTraces
            })

            it('makes a successful chat completion call with tools and content', async () => {
              nock('https://api.openai.com:443')
                .post('/v1/chat/completions')
                .reply(200, function () {
                  return fs.createReadStream(
                    Path.join(__dirname, 'streamed-responses/chat.completions.tool.and.content.txt')
                  )
                }, {
                  'Content-Type': 'text/plain',
                  'openai-organization': 'kill-9'
                })

              const checkTraces = agent
                .assertSomeTraces(traces => {
                  const span = traces[0][0]

                  expect(span).to.have.property('name', 'openai.request')
                  expect(span).to.have.property('type', 'openai')
                  expect(span).to.have.property('error', 0)
                  expect(span.meta).to.have.property('openai.organization.name', 'kill-9')
                  expect(span.meta).to.have.property('openai.request.method', 'POST')
                  expect(span.meta).to.have.property('openai.request.endpoint', '/v1/chat/completions')
                  expect(span.meta).to.have.property('openai.request.model', 'gpt-4')
                  expect(span.meta).to.have.property('openai.request.messages.0.content', 'Hello, OpenAI!')
                  expect(span.meta).to.have.property('openai.request.messages.0.role', 'user')
                  expect(span.meta).to.have.property('openai.request.messages.0.name', 'hunter2')
                  expect(span.meta).to.have.property('openai.response.choices.0.message.role', 'assistant')
                  expect(span.meta).to.have.property('openai.response.choices.0.message.content',
                    'THOUGHT: Hi')
                  expect(span.meta).to.have.property('openai.response.choices.0.finish_reason', 'tool_calls')
                  expect(span.meta).to.have.property('openai.response.choices.0.logprobs', 'returned')
                  expect(span.meta).to.have.property('openai.response.choices.0.message.tool_calls.0.function.name',
                    'finish')
                  expect(span.meta).to.have.property(
                    'openai.response.choices.0.message.tool_calls.0.function.arguments',
                    '{\n"answer": "5"\n}'
                  )
                })

              const stream = await openai.chat.completions.create({
                model: 'gpt-4',
                messages: [{ role: 'user', content: 'Hello, OpenAI!', name: 'hunter2' }],
                temperature: 0.5,
                tools: [], // dummy tools, the response is hardcoded
                stream: true
              })

              for await (const part of stream) {
                expect(part).to.have.property('choices')
                expect(part.choices[0]).to.have.property('delta')
              }

              await checkTraces
            })
          }
        })
      }

      if (semver.intersects('>=4.59.0', version)) {
        it('makes a successful call with the beta chat completions', async () => {
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
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: 'I am doing well, how about you?'
                  },
                  finish_reason: 'stop',
                  index: 0
                }
              ]
            })

          const checkTraces = agent
            .assertSomeTraces(traces => {
              const span = traces[0][0]
              expect(span).to.have.property('name', 'openai.request')
            })

          const prom = openai.beta.chat.completions.parse({
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'Hello, OpenAI!', name: 'hunter2' }],
            temperature: 0.5,
            stream: false
          })

          expect(prom).to.have.property('withResponse')

          const response = await prom

          expect(response.choices[0].message.content).to.eql('I am doing well, how about you?')

          await checkTraces
        })
      }
    })
  })
})
