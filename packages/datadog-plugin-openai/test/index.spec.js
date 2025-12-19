'use strict'

const { spawn } = require('child_process')
const fs = require('fs')
const assert = require('node:assert/strict')
const Path = require('path')

const semver = require('semver')
const sinon = require('sinon')

const { assertObjectContains, useEnv } = require('../../../integration-tests/helpers')
const { DogStatsDClient } = require('../../dd-trace/src/dogstatsd')
const { NoopExternalLogger } = require('../../dd-trace/src/external-logger/src')
const Sampler = require('../../dd-trace/src/sampler')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
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
        clock = sinon.useFakeTimers({
          toFake: ['Date']
        })

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
        const checkTraces = agent.assertFirstTraceSpan({
          error: 1,
          meta: {
            'error.type': 'Error'
          }
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

        sinon.assert.calledWith(metricStub, 'openai.request.error', 1, 'c', expectedTags)
        sinon.assert.calledWith(metricStub, 'openai.request.duration') // timing value not guaranteed

        sinon.assert.neverCalledWith(metricStub, 'openai.tokens.prompt')
        sinon.assert.neverCalledWith(metricStub, 'openai.tokens.completion')
        sinon.assert.neverCalledWith(metricStub, 'openai.tokens.total')
        sinon.assert.neverCalledWith(metricStub, 'openai.ratelimit.requests')
        sinon.assert.neverCalledWith(metricStub, 'openai.ratelimit.tokens')
        sinon.assert.neverCalledWith(metricStub, 'openai.ratelimit.remaining.requests')
        sinon.assert.neverCalledWith(metricStub, 'openai.ratelimit.remaining.tokens')
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
              assert.ok(result.id)
            } else {
              const result = await openai.createCompletion(params)
              assert.ok(result.data.id)
            }

            tracer.trace('child of outer', innerSpan => {
              assert.strictEqual(innerSpan.context()._parentId, outerSpan.context()._spanId)
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
              assert.ok(Object.hasOwn(part, 'choices'))
              assert.ok(Object.hasOwn(part.choices[0], 'delta'))
            }

            tracer.trace('child of outer', innerSpan => {
              assert.strictEqual(innerSpan.context()._parentId, outerSpan.context()._spanId)
            })
          })
        })
      })

      describe('completion', () => {
        it('makes a successful call', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].name, 'openai.request')
              assert.strictEqual(traces[0][0].type, 'openai')
              if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                assert.strictEqual(traces[0][0].resource, 'completions.create')
              } else {
                assert.strictEqual(traces[0][0].resource, 'createCompletion')
              }
              assert.ok('openai.request.endpoint' in traces[0][0].meta)
              assertObjectContains(traces[0][0], {
                error: 0,
                meta: {
                  'openai.request.method': 'POST',
                  'openai.request.endpoint': '/vcr/openai/completions',
                  component: 'openai',
                  '_dd.integration': 'openai',
                  'openai.request.model': 'gpt-3.5-turbo-instruct'
                }
              })
              assert.ok(Object.hasOwn(traces[0][0].meta, 'openai.response.model'))
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
            assert.ok(result.id)
          } else {
            const result = await openai.createCompletion(params)
            assert.ok(result.data.id)
          }

          await checkTraces

          clock.tick(10 * 1000)

          sinon.assert.called(metricStub)
          sinon.assert.called(externalLoggerStub)
        })

        it('tags multiple responses', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              // Multiple response choice tags removed - basic span validation
              assert.strictEqual(traces[0][0].name, 'openai.request')
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
            assert.ok(result.id)
          } else {
            const result = await openai.createCompletion(params)
            assert.ok(result.data.id)
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
                assert.ok(Object.hasOwn(traces[0][0].meta, 'openai.response.model'))
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
              assert.ok(Object.hasOwn(part, 'choices'))
              assert.ok(Object.hasOwn(part.choices[0], 'text'))
            }

            await checkTraces
          })

          it('makes a successful call with usage included', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                assert.ok(Object.hasOwn(traces[0][0].meta, 'openai.response.model'))
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
              assert.ok(Object.hasOwn(part, 'choices'))
              if (part.choices.length) { // last usage chunk will have no choices
                assert.ok(Object.hasOwn(part.choices[0], 'text'))
              }
            }

            await checkTraces
          })

          it('tags multiple responses', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                // Multiple response choice tags removed - basic span validation
                assert.strictEqual(traces[0][0].name, 'openai.request')
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
              assert.ok(Object.hasOwn(part, 'choices'))
              assert.ok(Object.hasOwn(part.choices[0], 'text'))
            }

            await checkTraces
          })
        })
      })

      it('create embedding', async () => {
        const checkTraces = agent
          .assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, 'openai.request')
            assert.strictEqual(traces[0][0].type, 'openai')
            if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
              assert.strictEqual(traces[0][0].resource, 'embeddings.create')
            } else {
              assert.strictEqual(traces[0][0].resource, 'createEmbedding')
            }
            assertObjectContains(traces[0][0], {
              error: 0,
              meta: {
                'openai.request.endpoint': '/vcr/openai/embeddings',
                'openai.request.method': 'POST',
                'openai.request.model': 'text-embedding-ada-002'
              }
            })
            assert.ok(Object.hasOwn(traces[0][0].meta, 'openai.response.model'))
          })

        const params = {
          model: 'text-embedding-ada-002',
          input: 'hello world',
          encoding_format: 'base64'
        }

        if (semver.satisfies(realVersion, '>=4.0.0')) {
          const result = await openai.embeddings.create(params)
          assert.ok(result.model)
        } else {
          const result = await openai.createEmbedding(params)
          assert.ok(result.data.model)
        }

        await checkTraces

        sinon.assert.calledWith(metricStub, 'openai.request.duration') // timing value not guaranteed
      })

      it('list models', async () => {
        const checkTraces = agent
          .assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, 'openai.request')
            assert.strictEqual(traces[0][0].type, 'openai')
            if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
              assert.strictEqual(traces[0][0].resource, 'models.list')
            } else {
              assert.strictEqual(traces[0][0].resource, 'listModels')
            }
            assertObjectContains(traces[0][0], {
              error: 0,
              meta: {
                'openai.request.method': 'GET',
                'openai.request.endpoint': '/vcr/openai/models'
              }
            })

            assert.ok(Object.hasOwn(traces[0][0].metrics, 'openai.response.count'))
          })

        if (semver.satisfies(realVersion, '>=4.0.0')) {
          const result = await openai.models.list()
          assert.deepStrictEqual(result.object, 'list')
          assert.ok(result.data.length)
        } else {
          const result = await openai.listModels()
          assert.deepStrictEqual(result.data.object, 'list')
          assert.ok(result.data.data.length)
        }

        await checkTraces
      })

      it('retrieve model', async () => {
        const checkTraces = agent
          .assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, 'openai.request')
            assert.strictEqual(traces[0][0].type, 'openai')
            if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
              assert.strictEqual(traces[0][0].resource, 'models.retrieve')
            } else {
              assert.strictEqual(traces[0][0].resource, 'retrieveModel')
            }
            // TODO: this might be a bug...
            assertObjectContains(traces[0][0], {
              error: 0,
              meta: {
                'openai.request.method': 'GET',
                'openai.request.endpoint': '/v1/models/*',
                'openai.request.id': 'gpt-4',
                'openai.response.owned_by': 'openai'
              }
            })
          })

        if (semver.satisfies(realVersion, '>=4.0.0')) {
          const result = await openai.models.retrieve('gpt-4')

          assert.deepStrictEqual(result.id, 'gpt-4')
        } else {
          const result = await openai.retrieveModel('gpt-4')

          assert.deepStrictEqual(result.data.id, 'gpt-4')
        }

        await checkTraces
      })

      it('delete model', async () => {
        const checkTraces = agent
          .assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, 'openai.request')
            assert.strictEqual(traces[0][0].type, 'openai')
            if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
              const method = semver.satisfies(realVersion, '>=5.0.0') ? 'delete' : 'del'
              assert.strictEqual(traces[0][0].resource, `models.${method}`)
            } else {
              assert.strictEqual(traces[0][0].resource, 'deleteModel')
            }
            assertObjectContains(traces[0][0], {
              error: 0,
              meta: {
                'openai.request.method': 'DELETE',
                'openai.request.endpoint': '/v1/models/*',
                'openai.response.id': 'ft:gpt-4.1-mini-2025-04-14:datadog-staging::BkaILRSh'
              },
              metrics: {
                'openai.response.deleted': 1
              }
            })
            assert.ok('openai.response.id' in traces[0][0].meta)
          })

        if (semver.satisfies(realVersion, '>=4.0.0')) {
          const method = semver.satisfies(realVersion, '>=5.0.0') ? 'delete' : 'del'
          const result = await openai.models[method]('ft:gpt-4.1-mini-2025-04-14:datadog-staging::BkaILRSh')

          assert.deepStrictEqual(result.deleted, true)
        } else {
          const result = await openai.deleteModel('ft:gpt-4.1-mini-2025-04-14:datadog-staging::BkaILRSh')

          assert.deepStrictEqual(result.data.deleted, true)
        }

        await checkTraces
      })

      it('list files', async () => {
        const checkTraces = agent
          .assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, 'openai.request')
            assert.strictEqual(traces[0][0].type, 'openai')
            if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
              assert.strictEqual(traces[0][0].resource, 'files.list')
            } else {
              assert.strictEqual(traces[0][0].resource, 'listFiles')
            }
            assertObjectContains(traces[0][0], {
              error: 0,
              meta: {
                'openai.request.endpoint': '/vcr/openai/files',
                'openai.request.method': 'GET'
              }
            })
            assert.ok(Object.hasOwn(traces[0][0].metrics, 'openai.response.count'))
          })

        if (semver.satisfies(realVersion, '>=4.0.0')) {
          const result = await openai.files.list()

          assert.ok(result.data.length)
          assert.ok(result.data[0].id)
        } else {
          const result = await openai.listFiles()

          assert.ok(result.data.data.length)
          assert.ok(result.data.data[0].id)
        }

        await checkTraces
      })

      it('create file', async function () {
        if (!semver.satisfies(realVersion, '>=4.0.0')) {
          this.skip()
        }

        const checkTraces = agent
          .assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, 'openai.request')
            assert.strictEqual(traces[0][0].type, 'openai')
            if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
              assert.strictEqual(traces[0][0].resource, 'files.create')
            } else {
              assert.strictEqual(traces[0][0].resource, 'createFile')
            }
            assertObjectContains(traces[0][0], {
              error: 0,
              meta: {
                'openai.request.endpoint': '/vcr/openai/files',
                'openai.request.method': 'POST',
                'openai.request.filename': 'fine-tune.jsonl',
                'openai.request.purpose': 'fine-tune',
                'openai.response.purpose': 'fine-tune',
                'openai.response.filename': 'fine-tune.jsonl'
              }
            })
            assert.ok(Object.hasOwn(traces[0][0].meta, 'openai.response.status'))
            assert.match(traces[0][0].meta['openai.response.id'], /^file-/)
            assert.ok(Object.hasOwn(traces[0][0].metrics, 'openai.response.bytes'))
            assert.ok(Object.hasOwn(traces[0][0].metrics, 'openai.response.created_at'))
          })

        if (semver.satisfies(realVersion, '>=4.0.0')) {
          const result = await openai.files.create({
            file: fs.createReadStream(Path.join(__dirname, 'fine-tune.jsonl')),
            purpose: 'fine-tune'
          })

          assert.deepStrictEqual(result.filename, 'fine-tune.jsonl')
        } else {
          const result = await openai.createFile(fs.createReadStream(
            Path.join(__dirname, 'fine-tune.jsonl')), 'fine-tune')

          assert.deepStrictEqual(result.data.filename, 'fine-tune.jsonl')
        }

        await checkTraces
      })

      it('retrieve file', async () => {
        const checkTraces = agent
          .assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, 'openai.request')
            assert.strictEqual(traces[0][0].type, 'openai')
            if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
              assert.strictEqual(traces[0][0].resource, 'files.retrieve')
            } else {
              assert.strictEqual(traces[0][0].resource, 'retrieveFile')
            }
            assertObjectContains(traces[0][0], {
              error: 0,
              meta: {
                'openai.request.method': 'GET',
                'openai.request.endpoint': '/v1/files/*',
                'openai.response.filename': 'fine-tune.jsonl',
                'openai.response.id': 'file-RpTpuvRVtnKpdKZb7DDGto',
                'openai.response.purpose': 'fine-tune'
              }
            })
            assert.ok(Object.hasOwn(traces[0][0].meta, 'openai.response.status'))
            assert.ok(Object.hasOwn(traces[0][0].metrics, 'openai.response.bytes'))
            assert.ok(Object.hasOwn(traces[0][0].metrics, 'openai.response.created_at'))
          })

        if (semver.satisfies(realVersion, '>=4.0.0')) {
          const result = await openai.files.retrieve('file-RpTpuvRVtnKpdKZb7DDGto')

          assert.ok(result.filename)
        } else {
          const result = await openai.retrieveFile('file-RpTpuvRVtnKpdKZb7DDGto')

          assert.ok(result.data.filename)
        }

        await checkTraces
      })

      it('download file', async () => {
        const checkTraces = agent
          .assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, 'openai.request')
            assert.strictEqual(traces[0][0].type, 'openai')
            if (semver.satisfies(realVersion, '>=4.0.0 <4.17.1') && DD_MAJOR < 6) {
              assert.strictEqual(traces[0][0].resource, 'files.retrieveContent')
            } else if (semver.satisfies(realVersion, '>=4.17.1') && DD_MAJOR < 6) {
              assert.strictEqual(traces[0][0].resource, 'files.content')
            } else {
              assert.strictEqual(traces[0][0].resource, 'downloadFile')
            }
            assertObjectContains(traces[0][0], {
              error: 0,
              meta: {
                'openai.request.method': 'GET',
                'openai.request.endpoint': '/v1/files/*/content'
              }
            })
          })

        if (semver.satisfies(realVersion, '>=4.0.0 < 4.17.1')) {
          const result = await openai.files.retrieveContent('file-RpTpuvRVtnKpdKZb7DDGto')

          assert.ok(result)
        } else if (semver.satisfies(realVersion, '>=4.17.1')) {
          const result = await openai.files.content('file-RpTpuvRVtnKpdKZb7DDGto')

          assert.deepStrictEqual(result.constructor.name, 'Response')
        } else {
          const result = await openai.downloadFile('file-RpTpuvRVtnKpdKZb7DDGto')

          assert.ok(result.data)
        }

        await checkTraces
      })

      it('delete file', async () => {
        const checkTraces = agent
          .assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, 'openai.request')
            assert.strictEqual(traces[0][0].type, 'openai')
            if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
              const method = semver.satisfies(realVersion, '>=5.0.0') ? 'delete' : 'del'
              assert.strictEqual(traces[0][0].resource, `files.${method}`)
            } else {
              assert.strictEqual(traces[0][0].resource, 'deleteFile')
            }
            assertObjectContains(traces[0][0], {
              error: 0,
              meta: {
                'openai.request.method': 'DELETE',
                'openai.request.endpoint': '/v1/files/*',
                'openai.response.id': 'file-RpTpuvRVtnKpdKZb7DDGto'
              }
            })
            assert.ok(Object.hasOwn(traces[0][0].metrics, 'openai.response.deleted'))
          })

        if (semver.satisfies(realVersion, '>=4.0.0')) {
          const method = semver.satisfies(realVersion, '>=5.0.0') ? 'delete' : 'del'
          const result = await openai.files[method]('file-RpTpuvRVtnKpdKZb7DDGto')

          assert.deepStrictEqual(result.deleted, true)
        } else {
          const result = await openai.deleteFile('file-RpTpuvRVtnKpdKZb7DDGto')

          assert.deepStrictEqual(result.data.deleted, true)
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
            assert.strictEqual(traces[0][0].name, 'openai.request')
            assert.strictEqual(traces[0][0].type, 'openai')
            if (semver.satisfies(realVersion, '>=4.17.0') && DD_MAJOR < 6) {
              assert.strictEqual(traces[0][0].resource, 'fine_tuning.jobs.create')
            } else {
              assert.strictEqual(traces[0][0].resource, 'createFineTune')
            }
            assert.ok('openai.request.endpoint' in traces[0][0].meta)
            assertObjectContains(traces[0][0], {
              error: 0,
              meta: {
                'openai.request.method': 'POST',
                'openai.request.endpoint': '/vcr/openai/fine_tuning/jobs',
                'openai.request.model': 'gpt-4.1-mini-2025-04-14',
                'openai.response.model': 'gpt-4.1-mini-2025-04-14'
              }
            })
            assert.match(traces[0][0].meta['openai.response.id'], /^ftjob-/)
            assert.ok(Object.hasOwn(traces[0][0].metrics, 'openai.response.created_at'))
          })

        const params = {
          training_file: 'file-RpTpuvRVtnKpdKZb7DDGto',
          model: 'gpt-4.1-mini-2025-04-14',
        }

        const result = await openai.fineTuning.jobs.create(params)
        assert.ok(result.id)

        await checkTraces
      })

      it('retrieve fine-tune', async function () {
        if (semver.satisfies(realVersion, '<4.17.0')) {
          this.skip()
        }

        const checkTraces = agent
          .assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, 'openai.request')
            assert.strictEqual(traces[0][0].type, 'openai')
            if (semver.satisfies(realVersion, '>=4.17.0') && DD_MAJOR < 6) {
              assert.strictEqual(traces[0][0].resource, 'fine_tuning.jobs.retrieve')
            } else {
              assert.strictEqual(traces[0][0].resource, 'retrieveFineTune')
            }
            assertObjectContains(traces[0][0], {
              error: 0,
              meta: {
                'openai.request.method': 'GET',
                'openai.request.endpoint': '/v1/fine_tuning/jobs/*',
                'openai.response.id': 'ftjob-q9CUUUsHJemGUVQ1Ecc01zcf'
              }
            })
            assert.ok(Object.hasOwn(traces[0][0].meta, 'openai.response.model'))
            assert.ok(Object.hasOwn(traces[0][0].metrics, 'openai.response.created_at'))
          })

        const result = await openai.fineTuning.jobs.retrieve('ftjob-q9CUUUsHJemGUVQ1Ecc01zcf')
        assert.deepStrictEqual(result.id, 'ftjob-q9CUUUsHJemGUVQ1Ecc01zcf')

        await checkTraces
      })

      it('cancel fine-tune', async function () {
        if (semver.satisfies(realVersion, '<4.17.0')) {
          this.skip()
        }

        const checkTraces = agent
          .assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, 'openai.request')
            assert.strictEqual(traces[0][0].type, 'openai')
            if (DD_MAJOR < 6) {
              assert.strictEqual(traces[0][0].resource, 'fine_tuning.jobs.cancel')
            } else {
              assert.strictEqual(traces[0][0].resource, 'cancelFineTune')
            }

            assertObjectContains(traces[0][0], {
              error: 0,
              meta: {
                'openai.request.method': 'POST',
                'openai.request.endpoint': '/v1/fine_tuning/jobs/*/cancel',
                'openai.response.id': 'ftjob-q9CUUUsHJemGUVQ1Ecc01zcf'
              }
            })
            assert.ok(Object.hasOwn(traces[0][0].metrics, 'openai.response.created_at'))
          })

        const result = await openai.fineTuning.jobs.cancel('ftjob-q9CUUUsHJemGUVQ1Ecc01zcf')
        assert.deepStrictEqual(result.id, 'ftjob-q9CUUUsHJemGUVQ1Ecc01zcf')

        await checkTraces
      })

      it('list fine-tune events', async function () {
        if (semver.satisfies(realVersion, '<4.17.0')) {
          this.skip()
        }

        const checkTraces = agent
          .assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, 'openai.request')
            assert.strictEqual(traces[0][0].type, 'openai')
            if (DD_MAJOR < 6) {
              assert.strictEqual(traces[0][0].resource, 'fine_tuning.jobs.listEvents')
            } else {
              assert.strictEqual(traces[0][0].resource, 'listFineTuneEvents')
            }

            assertObjectContains(traces[0][0], {
              error: 0,
              meta: {
                'openai.request.method': 'GET',
                'openai.request.endpoint': '/v1/fine_tuning/jobs/*/events'
              }
            })

            assert.ok(Object.hasOwn(traces[0][0].metrics, 'openai.response.count'))
          })

        const result = await openai.fineTuning.jobs.listEvents('ftjob-q9CUUUsHJemGUVQ1Ecc01zcf')
        assert.deepStrictEqual(result.body.object, 'list')

        await checkTraces
      })

      it('list fine-tunes', async function () {
        if (semver.satisfies(realVersion, '<4.17.0')) {
          this.skip()
        }

        const checkTraces = agent
          .assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, 'openai.request')
            assert.strictEqual(traces[0][0].type, 'openai')
            if (DD_MAJOR < 6) {
              assert.strictEqual(traces[0][0].resource, 'fine_tuning.jobs.list')
            } else {
              assert.strictEqual(traces[0][0].resource, 'listFineTunes')
            }
            assert.ok('openai.request.endpoint' in traces[0][0].meta)
            assertObjectContains(traces[0][0], {
              error: 0,
              meta: {
                'openai.request.method': 'GET',
                'openai.request.endpoint': '/vcr/openai/fine_tuning/jobs'
              }
            })

            assert.ok(Object.hasOwn(traces[0][0].metrics, 'openai.response.count'))
          })

        const result = await openai.fineTuning.jobs.list()
        assert.deepStrictEqual(result.body.object, 'list')

        await checkTraces
      })

      it('create moderation', async function () {
        if (semver.satisfies(realVersion, '<3.0.1')) {
          this.skip()
        }

        const checkTraces = agent
          .assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, 'openai.request')
            assert.strictEqual(traces[0][0].type, 'openai')
            if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
              assert.strictEqual(traces[0][0].resource, 'moderations.create')
            } else {
              assert.strictEqual(traces[0][0].resource, 'createModeration')
            }
            assertObjectContains(traces[0][0], {
              error: 0,
              meta: {
                'openai.request.method': 'POST',
                'openai.request.endpoint': '/vcr/openai/moderations'
              }
            })

            assert.match(traces[0][0].meta['openai.response.id'], /^modr-/)
            assert.ok(Object.hasOwn(traces[0][0].meta, 'openai.response.model'))
          })

        if (semver.satisfies(realVersion, '>=4.0.0')) {
          const result = await openai.moderations.create({
            input: 'I want to harm the robots'
          })

          assert.deepStrictEqual(result.results[0].flagged, true)
        } else {
          const result = await openai.createModeration({
            input: 'I want to harm the robots'
          })

          assert.deepStrictEqual(result.data.results[0].flagged, true)
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
              assert.strictEqual(traces[0][0].name, 'openai.request')
              assert.strictEqual(traces[0][0].type, 'openai')
              if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                assert.strictEqual(traces[0][0].resource, 'images.generate')
              } else {
                assert.strictEqual(traces[0][0].resource, 'createImage')
              }
              assert.ok('openai.request.endpoint' in traces[0][0].meta)
              assertObjectContains(traces[0][0], {
                error: 0,
                meta: {
                  'openai.request.method': 'POST',
                  'openai.request.endpoint': '/vcr/openai/images/generations',
                  'openai.request.model': 'dall-e-3'
                }
              })
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
              assert.strictEqual(result.data[0].url.startsWith('https://'), true)
            } else {
              assert.ok(result.data[0].b64_json)
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
              assert.strictEqual(result.data.data[0].url.startsWith('https://'), true)
            } else {
              assert.ok(result.data.data[0].b64_json)
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
            assert.strictEqual(traces[0][0].name, 'openai.request')
            assert.strictEqual(traces[0][0].type, 'openai')
            if (DD_MAJOR < 6) {
              assert.strictEqual(traces[0][0].resource, 'images.edit')
            } else {
              assert.strictEqual(traces[0][0].resource, 'createImageEdit')
            }
            assert.ok('openai.request.endpoint' in traces[0][0].meta)
            assertObjectContains(traces[0][0], {
              error: 0,
              meta: {
                'openai.request.method': 'POST',
                'openai.request.endpoint': '/vcr/openai/images/edits'
              }
            })
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

        assert.strictEqual(result.data[0].url.startsWith('https://'), true)

        await checkTraces
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
            assert.strictEqual(traces[0][0].name, 'openai.request')
            assert.strictEqual(traces[0][0].type, 'openai')
            if (DD_MAJOR < 6) {
              assert.strictEqual(traces[0][0].resource, 'images.createVariation')
            } else {
              assert.strictEqual(traces[0][0].resource, 'createImageVariation')
            }
            assert.ok('openai.request.endpoint' in traces[0][0].meta)
            assertObjectContains(traces[0][0], {
              error: 0,
              meta: {
                'openai.request.method': 'POST',
                'openai.request.endpoint': '/vcr/openai/images/variations'
              }
            })
          })

        if (semver.satisfies(realVersion, '>=4.0.0')) {
          const result = await openai.images.createVariation({
            image: fs.createReadStream(Path.join(__dirname, 'image.png')),
            n: 1,
            size: '256x256',
            response_format: 'url'
          })

          assert.strictEqual(result.data[0].url.startsWith('https://'), true)
        } else {
          const result = await openai.createImageVariation(
            fs.createReadStream(Path.join(__dirname, 'image.png')), 1, '256x256', 'url')

          assert.strictEqual(result.data.data[0].url.startsWith('https://'), true)
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
            assert.strictEqual(traces[0][0].name, 'openai.request')
            assert.strictEqual(traces[0][0].type, 'openai')
            if (DD_MAJOR < 6) {
              assert.strictEqual(traces[0][0].resource, 'audio.transcriptions.create')
            } else {
              assert.strictEqual(traces[0][0].resource, 'createTranscription')
            }
            assert.ok('openai.request.endpoint' in traces[0][0].meta)
            assertObjectContains(traces[0][0], {
              error: 0,
              meta: {
                'openai.request.endpoint': '/vcr/openai/audio/transcriptions',
                'openai.request.method': 'POST',
                'openai.request.model': 'gpt-4o-mini-transcribe'
              }
            })
          })

        const result = await openai.audio.transcriptions.create({
          file: fs.createReadStream(Path.join(__dirname, '/transcription.m4a')),
          model: 'gpt-4o-mini-transcribe',
          prompt: 'What does this say?',
          response_format: 'json',
          temperature: 0.5,
          language: 'en'
        })

        assert.deepStrictEqual(result.text, 'Hello friend.')

        await checkTraces
        sinon.assert.called(externalLoggerStub)
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
            assert.strictEqual(traces[0][0].name, 'openai.request')
            assert.strictEqual(traces[0][0].type, 'openai')
            if (DD_MAJOR < 6) {
              assert.strictEqual(traces[0][0].resource, 'audio.translations.create')
            } else {
              assert.strictEqual(traces[0][0].resource, 'createTranslation')
            }
            assert.ok('openai.request.endpoint' in traces[0][0].meta)
            assertObjectContains(traces[0][0], {
              error: 0,
              meta: {
                'openai.request.endpoint': '/vcr/openai/audio/translations',
                'openai.request.method': 'POST',
                'openai.request.model': 'whisper-1'
              }
            })
          })

        if (semver.satisfies(realVersion, '>=4.0.0')) {
          const result = await openai.audio.translations.create({
            file: fs.createReadStream(Path.join(__dirname, 'translation.m4a')),
            model: 'whisper-1',
            response_format: 'json',
            temperature: 0.5
          })

          assert.ok(result.text)
        } else {
          const result = await openai.createTranslation(
            fs.createReadStream(Path.join(__dirname, 'translation.m4a')),
            'whisper-1',
            undefined,
            'json',
            0.5
          )

          assert.ok(result.data.text)
        }

        await checkTraces

        sinon.assert.called(externalLoggerStub)
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
              assert.strictEqual(traces[0][0].name, 'openai.request')
              assert.strictEqual(traces[0][0].type, 'openai')
              if (semver.satisfies(realVersion, '>=4.0.0') && DD_MAJOR < 6) {
                assert.strictEqual(traces[0][0].resource, 'chat.completions.create')
              } else {
                assert.strictEqual(traces[0][0].resource, 'createChatCompletion')
              }
              assert.ok('openai.request.endpoint' in traces[0][0].meta)
              assertObjectContains(traces[0][0], {
                error: 0,
                meta: {
                  'openai.request.method': 'POST',
                  'openai.request.endpoint': '/vcr/openai/chat/completions',
                  'openai.request.model': 'gpt-3.5-turbo'
                }
              })
              assert.ok(Object.hasOwn(traces[0][0].meta, 'openai.response.model'))
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
            assert.ok(!Object.hasOwn(prom, 'withResponse') && ('withResponse' in prom))

            const result = await prom

            assert.ok(result.id)
            assert.ok(result.model)
            assert.deepStrictEqual(result.choices[0].message.role, 'assistant')
            assert.ok(result.choices[0].message.content)
            assert.ok(result.choices[0].finish_reason)
          } else {
            const result = await openai.createChatCompletion(params)

            assert.ok(result.data.id)
            assert.ok(result.data.model)
            assert.deepStrictEqual(result.data.choices[0].message.role, 'assistant')
            assert.ok(result.data.choices[0].message.content)
            assert.ok(result.data.choices[0].finish_reason)
          }

          await checkTraces

          sinon.assert.called(externalLoggerStub)
        })

        it('tags multiple responses', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].name, 'openai.request')
              assert.ok(Object.hasOwn(traces[0][0].meta, 'openai.response.model'))
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
            assert.ok(!Object.hasOwn(prom, 'withResponse') && ('withResponse' in prom))

            const result = await prom
            assert.strictEqual(result.choices.length, 3)
          } else {
            const result = await openai.createChatCompletion(params)
            assert.strictEqual(result.data.choices.length, 3)
          }

          await checkTraces
        })

        it('should tag image_url', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              const span = traces[0][0]
              assert.strictEqual(span.name, 'openai.request')
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
            assert.ok(result.id)
          } else {
            const result = await openai.createChatCompletion(params)
            assert.ok(result.data.id)
          }

          await checkTraces
        })

        it('should make a successful call with tools', async function () {
          if (semver.satisfies(realVersion, '<3.2.0')) {
            this.skip()
          }

          const checkTraces = agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].name, 'openai.request')
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
            assert.deepStrictEqual(result.choices[0].finish_reason, 'tool_calls')
          } else {
            const result = await openai.createChatCompletion(params)
            assert.deepStrictEqual(result.data.choices[0].finish_reason, 'tool_calls')
          }

          await checkTraces

          sinon.assert.called(externalLoggerStub)
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
                assert.strictEqual(traces[0][0].name, 'openai.request')
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
            assert.ok(!Object.hasOwn(prom, 'withResponse') && ('withResponse' in prom))
            const stream = await prom

            for await (const part of stream) {
              assert.ok(Object.hasOwn(part, 'choices'))
              assert.ok(Object.hasOwn(part.choices[0], 'delta'))
            }

            await checkTraces
          })

          it('tags multiple responses', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].name, 'openai.request')
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
            assert.ok(!Object.hasOwn(prom, 'withResponse') && ('withResponse' in prom))
            const stream = await prom

            for await (const part of stream) {
              assert.ok(Object.hasOwn(part, 'choices'))
              assert.ok(Object.hasOwn(part.choices[0], 'delta'))
            }

            await checkTraces
          })

          it('makes a successful call with usage included', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].name, 'openai.request')
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
            assert.ok(!Object.hasOwn(prom, 'withResponse') && ('withResponse' in prom))
            const stream = await prom

            for await (const part of stream) {
              assert.ok(Object.hasOwn(part, 'choices'))
              if (part.choices.length) { // last usage chunk will have no choices
                assert.ok(Object.hasOwn(part.choices[0], 'delta'))
              }
            }

            await checkTraces
          })

          it('tags multiple responses 2', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].name, 'openai.request')
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
            assert.ok(!Object.hasOwn(prom, 'withResponse') && ('withResponse' in prom))
            const stream = await prom

            for await (const part of stream) {
              assert.ok(Object.hasOwn(part, 'choices'))
              assert.ok(Object.hasOwn(part.choices[0], 'delta'))
            }

            await checkTraces
          })

          it('excludes image_url from usage', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].name, 'openai.request')
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
              assert.ok(Object.hasOwn(part, 'choices'))
              assert.ok(Object.hasOwn(part.choices[0], 'delta'))
            }

            await checkTraces
          })

          it('makes a successful call with tools', async function () {
            if (semver.satisfies(realVersion, '<=4.16.0')) {
              this.skip()
            }

            const checkTraces = agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].name, 'openai.request')
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
              assert.ok(Object.hasOwn(part, 'choices'))
              assert.ok(Object.hasOwn(part.choices[0], 'delta'))
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
            assert.strictEqual(span.name, 'openai.request')
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

        assert.ok(!Object.hasOwn(prom, 'withResponse') && ('withResponse' in prom))
        const response = await prom
        assert.ok(response.choices[0].message.content)

        await checkTraces
      })
    })
  })
})
