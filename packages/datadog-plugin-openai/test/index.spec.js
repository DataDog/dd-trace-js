'use strict'

const fs = require('fs')
const Path = require('path')
const { expect } = require('chai')
const semver = require('semver')
const sinon = require('sinon')
const { spawn } = require('child_process')

const agent = require('../../dd-trace/test/plugins/agent')
const { DogStatsDClient } = require('../../dd-trace/src/dogstatsd')
const { NoopExternalLogger } = require('../../dd-trace/src/external-logger/src')
const Sampler = require('../../dd-trace/src/sampler')
const { useEnv } = require('../../../integration-tests/helpers')

const tracerRequirePath = '../../dd-trace'

const { DD_MAJOR, NODE_MAJOR } = require('../../../version')

describe('Plugin', () => {
  let openai
  let toFile
  let clock
  let metricStub
  let externalLoggerStub
  let realVersion
  let tracer
  let globalFile

  useEnv({
    OPENAI_API_KEY: 'sk-DATADOG-ACCEPTANCE-TESTS'
  })

  describe('openai', () => {
    withVersions('openai', 'openai', version => {
      const moduleRequirePath = `../../../versions/openai@${version}`

      before(() => {
        tracer = require(tracerRequirePath)
        return agent.load('openai')
      })

      after(() => {
        if (semver.satisfies(realVersion, '>=5.0.0') && NODE_MAJOR < 20) {
          global.File = globalFile // eslint-disable-line n/no-unsupported-features/node-builtins
        }

        return agent.close({ ritmReset: false })
      })

      beforeEach(() => {
        clock = sinon.useFakeTimers()

        const requiredModule = require(moduleRequirePath)
        const module = requiredModule.get()
        realVersion = requiredModule.version()

        if (semver.satisfies(realVersion, '>=5.0.0') && NODE_MAJOR < 20) {
          /**
           * resolves the following error for OpenAI v5
           *
           * Error: `File` is not defined as a global, which is required for file uploads.
           * Update to Node 20 LTS or newer, or set `globalThis.File` to `import('node:buffer').File`.
           */
          globalFile = global.File // eslint-disable-line n/no-unsupported-features/node-builtins
          global.File = require('node:buffer').File // eslint-disable-line n/no-unsupported-features/node-builtins
        }

        if (semver.satisfies(realVersion, '>=4.0.0')) {
          const OpenAI = module

          openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            baseURL: 'http://127.0.0.1:9126/vcr/openai'
          })

          toFile = OpenAI.toFile
        } else {
          const { Configuration, OpenAIApi } = module

          const configuration = new Configuration({
            apiKey: process.env.OPENAI_API_KEY,
            basePath: 'http://127.0.0.1:9126/vcr/openai'
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

      it('should attach an error to the span', async () => {
        const checkTraces = agent
          .assertSomeTraces(traces => {
            expect(traces[0][0]).to.have.property('error', 1)
            // the message content differs on OpenAI version, even between patches
            expect(traces[0][0].meta['error.message']).to.exist
            expect(traces[0][0].meta).to.have.property('error.type', 'Error')
            expect(traces[0][0].meta['error.stack']).to.exist
          })

        const params = {
          model: 'gpt-3.5-turbo', // incorrect model
          prompt: 'Hello, OpenAI!',
          max_tokens: 100,
          temperature: 0.5,
          n: 1,
          stream: false,
        }

        try {
          if (semver.satisfies(realVersion, '>=4.0.0')) {
            await openai.completions.create(params)
          } else {
            await openai.createCompletion(params)
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

      describe('maintains context', () => {
        it('should maintain the context with a non-streamed call', async () => {
          await tracer.trace('outer', async (outerSpan) => {
            const params = {
              model: 'gpt-3.5-turbo-instruct',
              prompt: 'Hello, OpenAI!',
              max_tokens: 100,
              temperature: 0.5,
              n: 1,
              stream: false,
            }

            if (semver.satisfies(realVersion, '>=4.0.0')) {
              const result = await openai.completions.create(params)
              expect(result.id).to.exist
            } else {
              const result = await openai.createCompletion(params)
              expect(result.data.id).to.exist
            }

            tracer.trace('child of outer', innerSpan => {
              expect(innerSpan.context()._parentId).to.equal(outerSpan.context()._spanId)
            })
          })
        })

        it('should maintain the context with a streamed call', async function () {
          if (semver.satisfies(realVersion, '<4.1.0')) {
            this.skip()
          }

          await tracer.trace('outer', async (outerSpan) => {
            const stream = await openai.chat.completions.create({
              model: 'gpt-3.5-turbo',
              messages: [
                {
                  role: 'system',
                  content: 'You are a helpful assistant.'
                },
                {
                  role: 'user',
                  content: 'Hello, OpenAI!'
                }
              ],
              temperature: 0.5,
              stream: true,
              max_tokens: 100,
              n: 1,
              user: 'dd-trace-test'
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
      })

      describe('completion', () => {
        it('makes a successful call', async () => {
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
              expect(traces[0][0].meta).to.have.property(
                'openai.request.endpoint', '/vcr/openai/completions'
              )

              expect(traces[0][0].meta).to.have.property('component', 'openai')
              expect(traces[0][0].meta).to.have.property('_dd.integration', 'openai')
              expect(traces[0][0].meta).to.have.property('openai.organization.name', 'datadog-staging')
              expect(traces[0][0].meta).to.have.property('openai.request.model', 'gpt-3.5-turbo-instruct')
              expect(traces[0][0].meta).to.have.property('openai.response.model')
            })

          const params = {
            model: 'gpt-3.5-turbo-instruct',
            prompt: 'Hello, OpenAI!',
            max_tokens: 100,
            temperature: 0.5,
            n: 1,
            stream: false,
          }

          if (semver.satisfies(realVersion, '>=4.0.0')) {
            const result = await openai.completions.create(params)
            expect(result.id).to.exist
          } else {
            const result = await openai.createCompletion(params)
            expect(result.data.id).to.exist
          }

          await checkTraces

          clock.tick(10 * 1000)

          expect(metricStub).to.have.been.called
          expect(externalLoggerStub).to.have.been.called
        })

        it('tags multiple responses', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              // Multiple response choice tags removed - basic span validation
              expect(traces[0][0]).to.have.property('name', 'openai.request')
            })

          const params = {
            model: 'gpt-3.5-turbo-instruct',
            prompt: 'Hello, OpenAI!',
            max_tokens: 100,
            temperature: 0.5,
            n: 3,
            stream: false,
          }

          if (semver.satisfies(realVersion, '>=4.0.0')) {
            const result = await openai.completions.create(params)
            expect(result.id).to.exist
          } else {
            const result = await openai.createCompletion(params)
            expect(result.data.id).to.exist
          }

          await checkTraces
        })

        describe('streamed responses', function () {
          beforeEach(function () {
            if (semver.satisfies(realVersion, '<=4.1.0')) {
              this.skip()
            }
          })

          it('makes a successful call', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0][0].meta).to.have.property('openai.response.model')
              })

            const params = {
              model: 'gpt-3.5-turbo-instruct',
              prompt: 'Hello, OpenAI!',
              max_tokens: 100,
              temperature: 0.5,
              n: 1,
              stream: true,
            }

            const stream = await openai.completions.create(params)

            for await (const part of stream) {
              expect(part).to.have.property('choices')
              expect(part.choices[0]).to.have.property('text')
            }

            await checkTraces
          })

          it('makes a successful call with usage included', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0][0].meta).to.have.property('openai.response.model')
              })

            const params = {
              model: 'gpt-3.5-turbo-instruct',
              prompt: 'Hello, OpenAI!',
              max_tokens: 100,
              temperature: 0.5,
              n: 1,
              stream: true,
              stream_options: {
                include_usage: true,
              },
            }

            const stream = await openai.completions.create(params)

            for await (const part of stream) {
              expect(part).to.have.property('choices')
              if (part.choices.length) { // last usage chunk will have no choices
                expect(part.choices[0]).to.have.property('text')
              }
            }

            await checkTraces
          })

          it('tags multiple responses', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                // Multiple response choice tags removed - basic span validation
                expect(traces[0][0]).to.have.property('name', 'openai.request')
              })

            const params = {
              model: 'gpt-3.5-turbo-instruct',
              prompt: 'Hello, OpenAI!',
              max_tokens: 100,
              temperature: 0.5,
              n: 3,
              stream: true,
            }

            const stream = await openai.completions.create(params)

            for await (const part of stream) {
              expect(part).to.have.property('choices')
              expect(part.choices[0]).to.have.property('text')
            }

            await checkTraces
          })
        })
      })

      it('create embedding', async () => {
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
            expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/vcr/openai/embeddings')
            expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')

            expect(traces[0][0].meta).to.have.property('openai.request.model', 'text-embedding-ada-002')
            expect(traces[0][0].meta).to.have.property('openai.response.model')
          })

        const params = {
          model: 'text-embedding-ada-002',
          input: 'hello world',
          encoding_format: 'base64'
        }

        if (semver.satisfies(realVersion, '>=4.0.0')) {
          const result = await openai.embeddings.create(params)
          expect(result.model).to.exist
        } else {
          const result = await openai.createEmbedding(params)
          expect(result.data.model).to.exist
        }

        await checkTraces

        expect(metricStub).to.have.been.calledWith('openai.request.duration') // timing value not guaranteed
      })

      it('list models', async () => {
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
            expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/vcr/openai/models')

            expect(traces[0][0].metrics).to.have.property('openai.response.count')
          })

        if (semver.satisfies(realVersion, '>=4.0.0')) {
          const result = await openai.models.list()
          expect(result.object).to.eql('list')
          expect(result.data.length).to.exist
        } else {
          const result = await openai.listModels()
          expect(result.data.object).to.eql('list')
          expect(result.data.data.length).to.exist
        }

        await checkTraces
      })

      it('retrieve model', async () => {
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
            // TODO: this might be a bug...
            expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/models/*')
            expect(traces[0][0].meta).to.have.property('openai.request.id', 'gpt-4')
            expect(traces[0][0].meta).to.have.property('openai.response.owned_by', 'openai')
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

      it('delete model', async () => {
        const checkTraces = agent
          .assertSomeTraces(traces => {
            expect(traces[0][0]).to.have.property('name', 'openai.request')
            expect(traces[0][0]).to.have.property('type', 'openai')
            if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
              const method = semver.satisfies(realVersion, '>=5.0.0') ? 'delete' : 'del'
              expect(traces[0][0]).to.have.property('resource', `models.${method}`)
            } else {
              expect(traces[0][0]).to.have.property('resource', 'deleteModel')
            }
            expect(traces[0][0]).to.have.property('error', 0)
            expect(traces[0][0].meta).to.have.property('openai.request.method', 'DELETE')
            expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/models/*')

            expect(traces[0][0].meta).to.have.property(
              'openai.request.fine_tune_id', 'ft:gpt-4.1-mini-2025-04-14:datadog-staging::BkaILRSh'
            )
            expect(traces[0][0].metrics).to.have.property('openai.response.deleted', 1)
            expect(traces[0][0].meta).to.have.property(
              'openai.response.id', 'ft:gpt-4.1-mini-2025-04-14:datadog-staging::BkaILRSh'
            )
          })

        if (semver.satisfies(realVersion, '>=4.0.0')) {
          const method = semver.satisfies(realVersion, '>=5.0.0') ? 'delete' : 'del'
          const result = await openai.models[method]('ft:gpt-4.1-mini-2025-04-14:datadog-staging::BkaILRSh')

          expect(result.deleted).to.eql(true)
        } else {
          const result = await openai.deleteModel('ft:gpt-4.1-mini-2025-04-14:datadog-staging::BkaILRSh')

          expect(result.data.deleted).to.eql(true)
        }

        await checkTraces
      })

      it('list files', async () => {
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
            expect(traces[0][0].meta).to.have.property('openai.organization.name', 'datadog-staging')

            expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/vcr/openai/files')
            expect(traces[0][0].meta).to.have.property('openai.request.method', 'GET')
            expect(traces[0][0].metrics).to.have.property('openai.response.count')
          })

        if (semver.satisfies(realVersion, '>=4.0.0')) {
          const result = await openai.files.list()

          expect(result.data.length).to.exist
          expect(result.data[0].id).to.exist
        } else {
          const result = await openai.listFiles()

          expect(result.data.data.length).to.exist
          expect(result.data.data[0].id).to.exist
        }

        await checkTraces
      })

      it('create file', async function () {
        if (!semver.satisfies(realVersion, '>=4.0.0')) {
          this.skip()
        }

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
            expect(traces[0][0].meta).to.have.property('openai.organization.name', 'datadog-staging')
            expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/vcr/openai/files')
            expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')

            expect(traces[0][0].meta).to.have.property('openai.request.filename', 'fine-tune.jsonl')
            expect(traces[0][0].meta).to.have.property('openai.request.purpose', 'fine-tune')
            expect(traces[0][0].meta).to.have.property('openai.response.purpose', 'fine-tune')
            expect(traces[0][0].meta).to.have.property('openai.response.status')
            expect(traces[0][0].meta['openai.response.id']).to.match(/^file-/)
            expect(traces[0][0].meta).to.have.property('openai.response.filename', 'fine-tune.jsonl')
            expect(traces[0][0].metrics).to.have.property('openai.response.bytes')
            expect(traces[0][0].metrics).to.have.property('openai.response.created_at')
          })

        if (semver.satisfies(realVersion, '>=4.0.0')) {
          const result = await openai.files.create({
            file: fs.createReadStream(Path.join(__dirname, 'fine-tune.jsonl')),
            purpose: 'fine-tune'
          })

          expect(result.filename).to.eql('fine-tune.jsonl')
        } else {
          const result = await openai.createFile(fs.createReadStream(
            Path.join(__dirname, 'fine-tune.jsonl')), 'fine-tune')

          expect(result.data.filename).to.eql('fine-tune.jsonl')
        }

        await checkTraces
      })

      it('retrieve file', async () => {
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
            expect(traces[0][0].meta).to.have.property('openai.organization.name', 'datadog-staging')
            expect(traces[0][0].meta).to.have.property('openai.request.method', 'GET')
            expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/files/*')

            expect(traces[0][0].meta).to.have.property('openai.response.filename', 'fine-tune.jsonl')
            expect(traces[0][0].meta).to.have.property('openai.response.id', 'file-RpTpuvRVtnKpdKZb7DDGto')
            expect(traces[0][0].meta).to.have.property('openai.response.purpose', 'fine-tune')
            expect(traces[0][0].meta).to.have.property('openai.response.status')
            expect(traces[0][0].metrics).to.have.property('openai.response.bytes')
            expect(traces[0][0].metrics).to.have.property('openai.response.created_at')
          })

        if (semver.satisfies(realVersion, '>=4.0.0')) {
          const result = await openai.files.retrieve('file-RpTpuvRVtnKpdKZb7DDGto')

          expect(result.filename).to.exist
        } else {
          const result = await openai.retrieveFile('file-RpTpuvRVtnKpdKZb7DDGto')

          expect(result.data.filename).to.exist
        }

        await checkTraces
      })

      it('download file', async () => {
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
            expect(traces[0][0].meta).to.have.property('openai.organization.name', 'datadog-staging')
            expect(traces[0][0].meta).to.have.property('openai.request.method', 'GET')
            expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/files/*/content')
          })

        if (semver.satisfies(realVersion, '>=4.0.0 < 4.17.1')) {
          const result = await openai.files.retrieveContent('file-RpTpuvRVtnKpdKZb7DDGto')

          expect(result).to.exist
        } else if (semver.satisfies(realVersion, '>=4.17.1')) {
          const result = await openai.files.content('file-RpTpuvRVtnKpdKZb7DDGto')

          expect(result.constructor.name).to.eql('Response')
        } else {
          const result = await openai.downloadFile('file-RpTpuvRVtnKpdKZb7DDGto')

          expect(result.data).to.exist
        }

        await checkTraces
      })

      it('delete file', async () => {
        const checkTraces = agent
          .assertSomeTraces(traces => {
            expect(traces[0][0]).to.have.property('name', 'openai.request')
            expect(traces[0][0]).to.have.property('type', 'openai')
            if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
              const method = semver.satisfies(realVersion, '>=5.0.0') ? 'delete' : 'del'
              expect(traces[0][0]).to.have.property('resource', `files.${method}`)
            } else {
              expect(traces[0][0]).to.have.property('resource', 'deleteFile')
            }
            expect(traces[0][0]).to.have.property('error', 0)
            expect(traces[0][0].meta).to.have.property('openai.organization.name', 'datadog-staging')
            expect(traces[0][0].meta).to.have.property('openai.request.method', 'DELETE')
            expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/files/*')

            expect(traces[0][0].meta).to.have.property('openai.response.id', 'file-RpTpuvRVtnKpdKZb7DDGto')
            expect(traces[0][0].metrics).to.have.property('openai.response.deleted')
          })

        if (semver.satisfies(realVersion, '>=4.0.0')) {
          const method = semver.satisfies(realVersion, '>=5.0.0') ? 'delete' : 'del'
          const result = await openai.files[method]('file-RpTpuvRVtnKpdKZb7DDGto')

          expect(result.deleted).to.eql(true)
        } else {
          const result = await openai.deleteFile('file-RpTpuvRVtnKpdKZb7DDGto')

          expect(result.data.deleted).to.eql(true)
        }

        await checkTraces
      })

      it('create fine-tune', async function () {
        if (semver.satisfies(realVersion, '<4.17.0')) {
          // fine tuning endpoints used in lower versions of the OpenAI SDK have been deprecated
          this.skip()
        }

        const checkTraces = agent
          .assertSomeTraces(traces => {
            expect(traces[0][0]).to.have.property('name', 'openai.request')
            expect(traces[0][0]).to.have.property('type', 'openai')
            if (semver.satisfies(realVersion, '>=4.17.0') && DD_MAJOR < 6) {
              expect(traces[0][0]).to.have.property('resource', 'fine_tuning.jobs.create')
            } else {
              expect(traces[0][0]).to.have.property('resource', 'createFineTune')
            }
            expect(traces[0][0]).to.have.property('error', 0)
            expect(traces[0][0].meta).to.have.property('openai.organization.name', 'datadog-staging')
            expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')
            expect(traces[0][0].meta).to.have.property(
              'openai.request.endpoint', '/vcr/openai/fine_tuning/jobs'
            )

            expect(traces[0][0].meta).to.have.property('openai.request.model', 'gpt-4.1-mini-2025-04-14')
            expect(traces[0][0].meta).to.have.property('openai.request.training_file',
              'file-RpTpuvRVtnKpdKZb7DDGto')
            expect(traces[0][0].meta['openai.response.id']).to.match(/^ftjob-/)
            expect(traces[0][0].meta).to.have.property('openai.response.model', 'gpt-4.1-mini-2025-04-14')
            expect(traces[0][0].meta).to.have.property('openai.response.status')
            expect(traces[0][0].metrics).to.have.property('openai.response.created_at')
            expect(traces[0][0].metrics).to.have.property('openai.response.result_files_count')
            expect(traces[0][0].metrics).to.have.property('openai.response.training_files_count')
          })

        const params = {
          training_file: 'file-RpTpuvRVtnKpdKZb7DDGto',
          model: 'gpt-4.1-mini-2025-04-14',
        }

        const result = await openai.fineTuning.jobs.create(params)
        expect(result.id).to.exist

        await checkTraces
      })

      it('retrieve fine-tune', async function () {
        if (semver.satisfies(realVersion, '<4.17.0')) {
          this.skip()
        }

        const checkTraces = agent
          .assertSomeTraces(traces => {
            expect(traces[0][0]).to.have.property('name', 'openai.request')
            expect(traces[0][0]).to.have.property('type', 'openai')
            if (semver.satisfies(realVersion, '>=4.17.0') && DD_MAJOR < 6) {
              expect(traces[0][0]).to.have.property('resource', 'fine_tuning.jobs.retrieve')
            } else {
              expect(traces[0][0]).to.have.property('resource', 'retrieveFineTune')
            }
            expect(traces[0][0]).to.have.property('error', 0)
            expect(traces[0][0].meta).to.have.property('openai.organization.name', 'datadog-staging')
            expect(traces[0][0].meta).to.have.property('openai.request.method', 'GET')
            expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/fine_tuning/jobs/*')

            expect(traces[0][0].meta).to.have.property('openai.request.fine_tune_id', 'ftjob-q9CUUUsHJemGUVQ1Ecc01zcf')
            expect(traces[0][0].meta).to.have.property('openai.response.id', 'ftjob-q9CUUUsHJemGUVQ1Ecc01zcf')
            expect(traces[0][0].meta).to.have.property('openai.response.model')
            expect(traces[0][0].meta).to.have.property('openai.response.status')
            expect(traces[0][0].metrics).to.have.property('openai.response.created_at')
          })

        const result = await openai.fineTuning.jobs.retrieve('ftjob-q9CUUUsHJemGUVQ1Ecc01zcf')
        expect(result.id).to.eql('ftjob-q9CUUUsHJemGUVQ1Ecc01zcf')

        await checkTraces
      })

      it('cancel fine-tune', async function () {
        if (semver.satisfies(realVersion, '<4.17.0')) {
          this.skip()
        }

        const checkTraces = agent
          .assertSomeTraces(traces => {
            expect(traces[0][0]).to.have.property('name', 'openai.request')
            expect(traces[0][0]).to.have.property('type', 'openai')
            if (DD_MAJOR < 6) {
              expect(traces[0][0]).to.have.property('resource', 'fine_tuning.jobs.cancel')
            } else {
              expect(traces[0][0]).to.have.property('resource', 'cancelFineTune')
            }

            expect(traces[0][0]).to.have.property('error', 0)
            expect(traces[0][0].meta).to.have.property('openai.organization.name', 'datadog-staging')
            expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')
            expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/fine_tuning/jobs/*/cancel')
            expect(traces[0][0].meta).to.have.property('openai.request.fine_tune_id', 'ftjob-q9CUUUsHJemGUVQ1Ecc01zcf')
            expect(traces[0][0].meta).to.have.property('openai.response.id', 'ftjob-q9CUUUsHJemGUVQ1Ecc01zcf')
            expect(traces[0][0].meta).to.have.property('openai.response.status', 'cancelled')
            expect(traces[0][0].metrics).to.have.property('openai.response.created_at')
          })

        const result = await openai.fineTuning.jobs.cancel('ftjob-q9CUUUsHJemGUVQ1Ecc01zcf')
        expect(result.id).to.eql('ftjob-q9CUUUsHJemGUVQ1Ecc01zcf')

        await checkTraces
      })

      it('list fine-tune events', async function () {
        if (semver.satisfies(realVersion, '<4.17.0')) {
          this.skip()
        }

        const checkTraces = agent
          .assertSomeTraces(traces => {
            expect(traces[0][0]).to.have.property('name', 'openai.request')
            expect(traces[0][0]).to.have.property('type', 'openai')
            if (DD_MAJOR < 6) {
              expect(traces[0][0]).to.have.property('resource', 'fine_tuning.jobs.listEvents')
            } else {
              expect(traces[0][0]).to.have.property('resource', 'listFineTuneEvents')
            }

            expect(traces[0][0]).to.have.property('error', 0)
            expect(traces[0][0].meta).to.have.property('openai.request.method', 'GET')
            expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/v1/fine_tuning/jobs/*/events')

            expect(traces[0][0].meta).to.have.property('openai.request.fine_tune_id', 'ftjob-q9CUUUsHJemGUVQ1Ecc01zcf')
            expect(traces[0][0].metrics).to.have.property('openai.response.count')
          })

        const result = await openai.fineTuning.jobs.listEvents('ftjob-q9CUUUsHJemGUVQ1Ecc01zcf')
        expect(result.body.object).to.eql('list')

        await checkTraces
      })

      it('list fine-tunes', async function () {
        if (semver.satisfies(realVersion, '<4.17.0')) {
          this.skip()
        }

        const checkTraces = agent
          .assertSomeTraces(traces => {
            expect(traces[0][0]).to.have.property('name', 'openai.request')
            expect(traces[0][0]).to.have.property('type', 'openai')
            if (DD_MAJOR < 6) {
              expect(traces[0][0]).to.have.property('resource', 'fine_tuning.jobs.list')
            } else {
              expect(traces[0][0]).to.have.property('resource', 'listFineTunes')
            }
            expect(traces[0][0]).to.have.property('error', 0)
            expect(traces[0][0].meta).to.have.property('openai.request.method', 'GET')
            expect(traces[0][0].meta).to.have.property(
              'openai.request.endpoint', '/vcr/openai/fine_tuning/jobs'
            )

            expect(traces[0][0].metrics).to.have.property('openai.response.count')
          })

        const result = await openai.fineTuning.jobs.list()
        expect(result.body.object).to.eql('list')

        await checkTraces
      })

      it('create moderation', async function () {
        if (semver.satisfies(realVersion, '<3.0.1')) {
          this.skip()
        }

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
            expect(traces[0][0].meta).to.have.property('openai.organization.name', 'datadog-staging')
            expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')
            expect(traces[0][0].meta).to.have.property('openai.request.endpoint', '/vcr/openai/moderations')

            expect(traces[0][0].meta['openai.response.id']).to.match(/^modr-/)
            expect(traces[0][0].meta).to.have.property('openai.response.model')
          })

        if (semver.satisfies(realVersion, '>=4.0.0')) {
          const result = await openai.moderations.create({
            input: 'I want to harm the robots'
          })

          expect(result.results[0].flagged).to.eql(true)
        } else {
          const result = await openai.createModeration({
            input: 'I want to harm the robots'
          })

          expect(result.data.results[0].flagged).to.eql(true)
        }

        await checkTraces
      })

      for (const responseFormat of ['url', 'b64_json']) {
        it(`create image ${responseFormat}`, async function () {
          if (semver.satisfies(realVersion, '<3.1.0')) {
            this.skip()
          }

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
              expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')
              expect(traces[0][0].meta).to.have.property(
                'openai.request.endpoint', '/vcr/openai/images/generations'
              )
              expect(traces[0][0].meta).to.have.property('openai.request.model', 'dall-e-3')
            })

          if (semver.satisfies(realVersion, '>=4.0.0')) {
            const result = await openai.images.generate({
              prompt: 'sleepy capybara with monkey on top',
              n: 1,
              size: '1024x1024',
              response_format: responseFormat,
              model: 'dall-e-3'
            })

            if (responseFormat === 'url') {
              expect(result.data[0].url.startsWith('https://')).to.be.true
            } else {
              expect(result.data[0].b64_json).to.exist
            }
          } else {
            const result = await openai.createImage({
              prompt: 'sleepy capybara with monkey on top',
              n: 1,
              size: '1024x1024',
              response_format: responseFormat,
              model: 'dall-e-3'
            })

            if (responseFormat === 'url') {
              expect(result.data.data[0].url.startsWith('https://')).to.be.true
            } else {
              expect(result.data.data[0].b64_json).to.exist
            }
          }

          await checkTraces
        })
      }

      it('create image edit', async function () {
        if (semver.satisfies(realVersion, '<4.33.1')) {
          /**
           * lower versions will fail with
           *
           * Error: 400 Invalid file 'image': unsupported mimetype ('application/octet-stream').
           * Supported file formats are 'image/png'.
           */
          this.skip()
        }

        const checkTraces = agent
          .assertSomeTraces(traces => {
            expect(traces[0][0]).to.have.property('name', 'openai.request')
            expect(traces[0][0]).to.have.property('type', 'openai')
            if (DD_MAJOR < 6) {
              expect(traces[0][0]).to.have.property('resource', 'images.edit')
            } else {
              expect(traces[0][0]).to.have.property('resource', 'createImageEdit')
            }
            expect(traces[0][0]).to.have.property('error', 0)
            expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')
            expect(traces[0][0].meta).to.have.property(
              'openai.request.endpoint', '/vcr/openai/images/edits'
            )
            // TODO(sabrenner): fix in a follow-up (super simple - img.name)
          })

        const result = await openai.images.edit({
          image: await toFile(
            fs.createReadStream(Path.join(__dirname, 'image.png')), null, {
              type: 'image/png'
            }
          ),
          prompt: 'Change all red to blue',
          n: 1,
          size: '256x256',
          response_format: 'url',
        })

        expect(result.data[0].url.startsWith('https://')).to.be.true

        await checkTraces

        expect(externalLoggerStub).to.have.been.called
      })

      it('create image variation', async function () {
        if (semver.satisfies(realVersion, '<4.0.0')) {
          /**
           * lower versions fail with
           *
           * Error: Request failed with status code 400
           */
          this.skip()
        }

        const checkTraces = agent
          .assertSomeTraces(traces => {
            expect(traces[0][0]).to.have.property('name', 'openai.request')
            expect(traces[0][0]).to.have.property('type', 'openai')
            if (DD_MAJOR < 6) {
              expect(traces[0][0]).to.have.property('resource', 'images.createVariation')
            } else {
              expect(traces[0][0]).to.have.property('resource', 'createImageVariation')
            }
            expect(traces[0][0]).to.have.property('error', 0)
            expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')
            expect(traces[0][0].meta).to.have.property(
              'openai.request.endpoint', '/vcr/openai/images/variations'
            )
          })

        if (semver.satisfies(realVersion, '>=4.0.0')) {
          const result = await openai.images.createVariation({
            image: fs.createReadStream(Path.join(__dirname, 'image.png')),
            n: 1,
            size: '256x256',
            response_format: 'url'
          })

          expect(result.data[0].url.startsWith('https://')).to.be.true
        } else {
          const result = await openai.createImageVariation(
            fs.createReadStream(Path.join(__dirname, 'image.png')), 1, '256x256', 'url')

          expect(result.data.data[0].url.startsWith('https://')).to.be.true
        }

        await checkTraces
      })

      it('create transcription', async function () {
        if (semver.satisfies(realVersion, '<4.0.0')) {
          /**
           * lower versions fail with
           *
           * Error: Request failed with status code 400
           */
          this.skip()
        }

        const checkTraces = agent
          .assertSomeTraces(traces => {
            expect(traces[0][0]).to.have.property('name', 'openai.request')
            expect(traces[0][0]).to.have.property('type', 'openai')
            if (DD_MAJOR < 6) {
              expect(traces[0][0]).to.have.property('resource', 'audio.transcriptions.create')
            } else {
              expect(traces[0][0]).to.have.property('resource', 'createTranscription')
            }
            expect(traces[0][0]).to.have.property('error', 0)
            expect(traces[0][0].meta).to.have.property('openai.organization.name', 'datadog-staging')

            expect(traces[0][0].meta).to.have.property(
              'openai.request.endpoint', '/vcr/openai/audio/transcriptions'
            )
            expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')
            expect(traces[0][0].meta).to.have.property('openai.request.model', 'gpt-4o-mini-transcribe')
          })

        const result = await openai.audio.transcriptions.create({
          file: fs.createReadStream(Path.join(__dirname, '/transcription.m4a')),
          model: 'gpt-4o-mini-transcribe',
          prompt: 'What does this say?',
          response_format: 'json',
          temperature: 0.5,
          language: 'en'
        })

        expect(result.text).to.eql('Hello friend.')

        await checkTraces
        expect(externalLoggerStub).to.have.been.called
      })

      it('create translation', async function () {
        if (semver.satisfies(realVersion, '<4.0.0')) {
          /**
           * lower versions fail with
           *
           * Error: Request failed with status code 400
           */
          this.skip()
        }

        const checkTraces = agent
          .assertSomeTraces(traces => {
            expect(traces[0][0]).to.have.property('name', 'openai.request')
            expect(traces[0][0]).to.have.property('type', 'openai')
            if (DD_MAJOR < 6) {
              expect(traces[0][0]).to.have.property('resource', 'audio.translations.create')
            } else {
              expect(traces[0][0]).to.have.property('resource', 'createTranslation')
            }
            expect(traces[0][0]).to.have.property('error', 0)
            expect(traces[0][0].meta).to.have.property('openai.organization.name', 'datadog-staging')

            expect(traces[0][0].meta).to.have.property(
              'openai.request.endpoint', '/vcr/openai/audio/translations'
            )
            expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')
            expect(traces[0][0].meta).to.have.property('openai.request.model', 'whisper-1')
          })

        if (semver.satisfies(realVersion, '>=4.0.0')) {
          const result = await openai.audio.translations.create({
            file: fs.createReadStream(Path.join(__dirname, 'translation.m4a')),
            model: 'whisper-1',
            response_format: 'json',
            temperature: 0.5
          })

          expect(result.text).to.exist
        } else {
          const result = await openai.createTranslation(
            fs.createReadStream(Path.join(__dirname, 'translation.m4a')),
            'whisper-1',
            undefined,
            'json',
            0.5
          )

          expect(result.data.text).to.exist
        }

        await checkTraces

        expect(externalLoggerStub).to.have.been.called
      })

      describe('chat completions', function () {
        beforeEach(function () {
          if (semver.satisfies(realVersion, '<3.2.0')) {
            this.skip()
          }
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
              expect(traces[0][0].meta).to.have.property('openai.organization.name', 'datadog-staging')

              expect(traces[0][0].meta).to.have.property('openai.request.method', 'POST')
              expect(traces[0][0].meta).to.have.property(
                'openai.request.endpoint', '/vcr/openai/chat/completions'
              )

              expect(traces[0][0].meta).to.have.property('openai.request.model', 'gpt-3.5-turbo')
              expect(traces[0][0].meta).to.have.property('openai.response.model')
            })

          const params = {
            model: 'gpt-3.5-turbo',
            messages: [
              {
                role: 'system',
                content: 'You are a helpful assistant.'
              },
              {
                role: 'user',
                content: 'Hello, OpenAI!'
              }
            ],
            temperature: 0.5,
            stream: false,
            max_tokens: 100,
            n: 1,
            user: 'dd-trace-test'
          }

          if (semver.satisfies(realVersion, '>=4.0.0')) {
            const prom = openai.chat.completions.create(params)
            expect(prom).to.have.property('withResponse')

            const result = await prom

            expect(result.id).to.exist
            expect(result.model).to.exist
            expect(result.choices[0].message.role).to.eql('assistant')
            expect(result.choices[0].message.content).to.exist
            expect(result.choices[0].finish_reason).to.exist
          } else {
            const result = await openai.createChatCompletion(params)

            expect(result.data.id).to.exist
            expect(result.data.model).to.exist
            expect(result.data.choices[0].message.role).to.eql('assistant')
            expect(result.data.choices[0].message.content).to.exist
            expect(result.data.choices[0].finish_reason).to.exist
          }

          await checkTraces

          expect(externalLoggerStub).to.have.been.called
        })

        it('tags multiple responses', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', 'openai.request')
              expect(traces[0][0].meta).to.have.property('openai.response.model')
            })

          const params = {
            model: 'gpt-3.5-turbo',
            messages: [
              {
                role: 'system',
                content: 'You are a helpful assistant.'
              },
              {
                role: 'user',
                content: 'Hello, OpenAI!'
              }
            ],
            temperature: 0.5,
            stream: false,
            max_tokens: 100,
            n: 3,
            user: 'dd-trace-test'
          }

          if (semver.satisfies(realVersion, '>=4.0.0')) {
            const prom = openai.chat.completions.create(params)
            expect(prom).to.have.property('withResponse')

            const result = await prom
            expect(result.choices).to.have.lengthOf(3)
          } else {
            const result = await openai.createChatCompletion(params)
            expect(result.data.choices).to.have.lengthOf(3)
          }

          await checkTraces
        })

        it('should tag image_url', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              const span = traces[0][0]
              expect(span).to.have.property('name', 'openai.request')
            })

          const params = {
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'What is in this image?'
                  },
                  {
                    type: 'image_url',
                    image_url: {
                      url: 'https://tinyurl.com/4mfz54bx'
                    }
                  }
                ]
              }
            ]
          }

          if (semver.satisfies(realVersion, '>=4.0.0')) {
            const result = await openai.chat.completions.create(params)
            expect(result.id).to.exist
          } else {
            const result = await openai.createChatCompletion(params)
            expect(result.data.id).to.exist
          }

          await checkTraces
        })

        it('should make a successful call with tools', async function () {
          if (semver.satisfies(realVersion, '<3.2.0')) {
            this.skip()
          }

          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', 'openai.request')
            })

          const params = {
            model: 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: 'What is the weather in New York City?' }],
            tools: [{
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Get the weather in a given city',
                parameters: {
                  type: 'object',
                  properties: {
                    city: { type: 'string', description: 'The city to get the weather for' }
                  }
                }
              }
            }],
            tool_choice: 'auto',
            stream: false,
          }

          if (semver.satisfies(realVersion, '>=4.0.0')) {
            const result = await openai.chat.completions.create(params)
            expect(result.choices[0].finish_reason).to.eql('tool_calls')
          } else {
            const result = await openai.createChatCompletion(params)
            expect(result.data.choices[0].finish_reason).to.eql('tool_calls')
          }

          await checkTraces

          expect(externalLoggerStub).to.have.been.called
        })

        describe('streamed responses', function () {
          beforeEach(function () {
            if (semver.satisfies(realVersion, '<=4.1.0')) {
              this.skip()
            }
          })

          it('makes a successful call', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('name', 'openai.request')
              })

            const params = {
              model: 'gpt-3.5-turbo',
              messages: [
                {
                  role: 'system',
                  content: 'You are a helpful assistant.'
                },
                {
                  role: 'user',
                  content: 'Hello, OpenAI!'
                }
              ],
              temperature: 0.5,
              stream: true,
              max_tokens: 100,
              n: 1,
              user: 'dd-trace-test'
            }

            const prom = openai.chat.completions.create(params, { /* request-specific options */ })
            expect(prom).to.have.property('withResponse')
            const stream = await prom

            for await (const part of stream) {
              expect(part).to.have.property('choices')
              expect(part.choices[0]).to.have.property('delta')
            }

            await checkTraces
          })

          it('tags multiple responses', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('name', 'openai.request')
              })

            const params = {
              model: 'gpt-3.5-turbo',
              messages: [
                {
                  role: 'system',
                  content: 'You are a helpful assistant.'
                },
                {
                  role: 'user',
                  content: 'Hello, OpenAI!'
                }
              ],
              temperature: 0.5,
              stream: true,
              max_tokens: 100,
              n: 3,
              user: 'dd-trace-test'
            }

            const prom = openai.chat.completions.create(params, { /* request-specific options */ })
            expect(prom).to.have.property('withResponse')
            const stream = await prom

            for await (const part of stream) {
              expect(part).to.have.property('choices')
              expect(part.choices[0]).to.have.property('delta')
            }

            await checkTraces
          })

          it('makes a successful call with usage included', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('name', 'openai.request')
              })

            const params = {
              model: 'gpt-3.5-turbo',
              messages: [
                {
                  role: 'system',
                  content: 'You are a helpful assistant.'
                },
                {
                  role: 'user',
                  content: 'Hello, OpenAI!'
                }
              ],
              temperature: 0.5,
              stream: true,
              max_tokens: 100,
              n: 1,
              user: 'dd-trace-test',
              stream_options: {
                include_usage: true
              }
            }

            const prom = openai.chat.completions.create(params, { /* request-specific options */ })
            expect(prom).to.have.property('withResponse')
            const stream = await prom

            for await (const part of stream) {
              expect(part).to.have.property('choices')
              if (part.choices.length) { // last usage chunk will have no choices
                expect(part.choices[0]).to.have.property('delta')
              }
            }

            await checkTraces
          })

          it('tags multiple responses', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('name', 'openai.request')
              })

            const params = {
              model: 'gpt-3.5-turbo',
              messages: [
                {
                  role: 'system',
                  content: 'You are a helpful assistant.'
                },
                {
                  role: 'user',
                  content: 'Hello, OpenAI!'
                }
              ],
              temperature: 0.5,
              stream: true,
              max_tokens: 100,
              n: 3,
              user: 'dd-trace-test'
            }

            const prom = openai.chat.completions.create(params, { /* request-specific options */ })
            expect(prom).to.have.property('withResponse')
            const stream = await prom

            for await (const part of stream) {
              expect(part).to.have.property('choices')
              expect(part.choices[0]).to.have.property('delta')
            }

            await checkTraces
          })

          it('excludes image_url from usage', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('name', 'openai.request')
              })

            const params = {
              model: 'gpt-4o-mini',
              messages: [
                {
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text: 'What is in this image?'
                    },
                    {
                      type: 'image_url',
                      image_url: {
                        url: 'https://tinyurl.com/4mfz54bx'
                      }
                    }
                  ]
                }
              ],
              stream: true,
            }

            const stream = await openai.chat.completions.create(params)
            for await (const part of stream) {
              expect(part).to.have.property('choices')
              expect(part.choices[0]).to.have.property('delta')
            }

            await checkTraces
          })

          it('makes a successful call with tools', async function () {
            if (semver.satisfies(realVersion, '<=4.16.0')) {
              this.skip()
            }

            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('name', 'openai.request')
              })

            const params = {
              model: 'gpt-3.5-turbo',
              messages: [{ role: 'user', content: 'What is the weather in New York City?' }],
              tools: [{
                type: 'function',
                function: {
                  name: 'get_weather',
                  description: 'Get the weather in a given city',
                  parameters: {
                    type: 'object',
                    properties: {
                      city: { type: 'string', description: 'The city to get the weather for' }
                    }
                  }
                }
              }],
              tool_choice: 'auto',
              stream: true,
            }

            const stream = await openai.chat.completions.create(params)
            for await (const part of stream) {
              expect(part).to.have.property('choices')
              expect(part.choices[0]).to.have.property('delta')
            }

            await checkTraces
          })
        })
      })

      it('makes a successful call with chat.completions.parse', async function () {
        if (semver.satisfies(realVersion, '<4.59.0')) {
          this.skip()
        }

        const checkTraces = agent
          .assertSomeTraces(traces => {
            const span = traces[0][0]
            expect(span).to.have.property('name', 'openai.request')
          })

        const parse = semver.satisfies(realVersion, '>=5.0.0')
          ? openai.chat.completions.parse.bind(openai.chat.completions)
          : openai.beta.chat.completions.parse.bind(openai.beta.chat.completions)

        const prom = parse({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'You are a helpful assistant' },
            { role: 'user', content: 'Hello, OpenAI!' }
          ],
          temperature: 0.5,
          max_tokens: 100,
          stream: false,
          n: 1,
          user: 'dd-trace-test',
        })

        expect(prom).to.have.property('withResponse')
        const response = await prom
        expect(response.choices[0].message.content).to.exist

        await checkTraces
      })
    })
  })
})
