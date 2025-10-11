'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, before, after } = require('mocha')

const { useEnv } = require('../../../integration-tests/helpers')
const agent = require('../../dd-trace/test/plugins/agent')
const iastFilter = require('../../dd-trace/src/appsec/iast/taint-tracking/filter')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

const isDdTrace = iastFilter.isDdTrace

describe('Plugin', () => {
  let langchainOpenai
  let langchainAnthropic
  let langchainGoogleGenAI

  let langchainMessages
  let langchainOutputParsers
  let langchainPrompts
  let langchainRunnables
  let langchainTools
  let MemoryVectorStore

  useEnv({
    OPENAI_API_KEY: '<not-a-real-key>',
    ANTHROPIC_API_KEY: '<not-a-real-key>',
    GOOGLE_API_KEY: '<not-a-real-key>'
  })

  function getLangChainOpenAiClient (type = 'llm', options = {}) {
    Object.assign(options, {
      configuration: {
        baseURL: 'http://127.0.0.1:9126/vcr/openai'
      }
    })

    if (type === 'llm') {
      return new langchainOpenai.OpenAI(options)
    }

    if (type === 'chat') {
      return new langchainOpenai.ChatOpenAI(options)
    }

    if (type === 'embedding') {
      return new langchainOpenai.OpenAIEmbeddings(options)
    }

    throw new Error(`Invalid type: ${type}`)
  }

  function getLangChainAnthropicClient (type = 'chat', options = {}) {
    Object.assign(options, {
      clientOptions: {
        baseURL: 'http://127.0.0.1:9126/vcr/anthropic'
      }
    })

    if (type === 'chat') {
      return new langchainAnthropic.ChatAnthropic(options)
    }

    throw new Error(`Invalid type: ${type}`)
  }

  function getLangChainGoogleGenAIClient (type = 'embedding', options = {}) {
    Object.assign(options, {
      baseUrl: 'http://127.0.0.1:9126/vcr/genai'
    })

    if (type === 'embedding') {
      return new langchainGoogleGenAI.GoogleGenerativeAIEmbeddings(options)
    }

    throw new Error(`Invalid type: ${type}`)
  }

  describe('langchain', () => {
    withVersions('langchain', ['@langchain/core'], (version, _, realVersion) => {
      before(() => {
        iastFilter.isDdTrace = file => {
          if (file.includes('dd-trace-js/versions/')) {
            return false
          }
          return isDdTrace(file)
        }
        return agent.load('langchain')
      })

      after(() => {
        iastFilter.isDdTrace = isDdTrace
        // wiping in order to read new env vars for the config each time
        return agent.close({ ritmReset: false })
      })

      beforeEach(() => {
        langchainOpenai = require('../../../versions/@langchain/openai@0.1.0').get()
        langchainAnthropic = require(`../../../versions/@langchain/anthropic@${version}`).get()
        if (version !== '0.1.0') {
          // version mismatching otherwise
          // can probably scaffold `withVersions` better to make this a bit cleaner
          langchainGoogleGenAI = require(`../../../versions/@langchain/google-genai@${version}`).get()
        }

        // need to specify specific import in `get(...)`
        langchainMessages = require(`../../../versions/@langchain/core@${version}`).get('@langchain/core/messages')
        langchainOutputParsers = require(`../../../versions/@langchain/core@${version}`)
          .get('@langchain/core/output_parsers')
        langchainPrompts = require(`../../../versions/@langchain/core@${version}`).get('@langchain/core/prompts')
        langchainRunnables = require(`../../../versions/@langchain/core@${version}`).get('@langchain/core/runnables')

        langchainTools = require(`../../../versions/@langchain/core@${version}`)
          .get('@langchain/core/tools')

        MemoryVectorStore = require(`../../../versions/langchain@${version}`)
          .get('langchain/vectorstores/memory')
          .MemoryVectorStore
      })

      describe('llm', () => {
        it('does not tag output on error', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0].length).to.equal(1)

              const span = traces[0][0]

              const langchainResponseRegex = /^langchain\.response\.completions\./
              const hasMatching = Object.keys(span.meta).some(key => langchainResponseRegex.test(key))

              expect(hasMatching).to.be.false

              expect(span.meta).to.have.property('error.message')
              expect(span.meta).to.have.property('error.type')
              expect(span.meta).to.have.property('error.stack')
            })

          try {
            const llm = getLangChainOpenAiClient('llm',
              { model: 'text-embedding-3-small', maxRetries: 0 }
            ) // use this bad model (embedding model not compatible)
            await llm.generate(['what is 2 + 2?'])
          } catch {}

          await checkTraces
        })

        it('instruments a langchain llm call for a single prompt', async () => {
          const llm = getLangChainOpenAiClient('llm', { model: 'gpt-3.5-turbo-instruct' })
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0].length).to.equal(1)
              const span = traces[0][0]

              expect(span).to.have.property('name', 'langchain.request')
              expect(span).to.have.property('resource', 'langchain.llms.openai.OpenAI')

              expect(span.meta).to.have.property('langchain.request.provider', 'openai')
              expect(span.meta).to.have.property('langchain.request.model', 'gpt-3.5-turbo-instruct')
              expect(span.meta).to.have.property('langchain.request.type', 'llm')
            })

          const result = await llm.generate(['what is 2 + 2?'])

          expect(result.generations[0][0].text).to.exist

          await checkTraces
        })

        it('instruments a langchain openai llm call for multiple prompts', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0].length).to.equal(1)
              const span = traces[0][0]
              expect(span.meta).to.have.property('langchain.request.provider', 'openai')
              expect(span.meta).to.have.property('langchain.request.model', 'gpt-3.5-turbo-instruct')
            })

          const llm = getLangChainOpenAiClient('llm', { model: 'gpt-3.5-turbo-instruct' })
          const result = await llm.generate(['what is 2 + 2?', 'what is the circumference of the earth?'])

          expect(result.generations[0][0].text).to.exist
          expect(result.generations[1][0].text).to.exist

          await checkTraces
        })

        it('instruments a langchain openai llm call for a single prompt and multiple responses', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0].length).to.equal(1)
              const span = traces[0][0]

              expect(span.meta).to.have.property('langchain.request.provider', 'openai')
              expect(span.meta).to.have.property('langchain.request.model', 'gpt-3.5-turbo-instruct')
            })

          const llm = getLangChainOpenAiClient('llm', { model: 'gpt-3.5-turbo-instruct', n: 2 })
          const result = await llm.generate(['what is 2 + 2?'])

          expect(result.generations[0][0].text).to.exist
          expect(result.generations[0][1].text).to.exist

          await checkTraces
        })
      })

      describe('chat model', () => {
        it('does not tag output on error', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0].length).to.equal(1)

              const span = traces[0][0]

              const langchainResponseRegex = /^langchain\.response\.completions\./
              const hasMatching = Object.keys(span.meta).some(key => langchainResponseRegex.test(key))
              expect(hasMatching).to.be.false

              expect(span.meta).to.have.property('error.message')
              expect(span.meta).to.have.property('error.type')
              expect(span.meta).to.have.property('error.stack')
            })

          try {
            const chatModel = getLangChainOpenAiClient('chat', { model: 'gpt-3.5-turbo-instruct', maxRetries: 0 })
            await chatModel.invoke('Hello!')
          } catch {}

          await checkTraces
        })

        it('instruments a langchain openai chat model call for a single string prompt', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0].length).to.equal(1)
              const span = traces[0][0]

              expect(span).to.have.property('name', 'langchain.request')
              expect(span).to.have.property('resource', 'langchain.chat_models.openai.ChatOpenAI')

              expect(span.meta).to.have.property('langchain.request.provider', 'openai')
              expect(span.meta).to.have.property('langchain.request.model', 'gpt-4')
              expect(span.meta).to.have.property('langchain.request.type', 'chat_model')
            })

          const chatModel = getLangChainOpenAiClient('chat', { model: 'gpt-4' })
          const result = await chatModel.invoke('Hello!')

          expect(result.content).to.exist

          await checkTraces
        })

        it('instruments a langchain openai chat model call for a JSON message input', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0].length).to.equal(1)
              const span = traces[0][0]

              expect(span.meta).to.have.property('langchain.request.provider', 'openai')
              expect(span.meta).to.have.property('langchain.request.model', 'gpt-4')
            })

          const chatModel = getLangChainOpenAiClient('chat', { model: 'gpt-4' })
          const messages = [
            { role: 'system', content: 'You only respond with one word answers' },
            { role: 'human', content: 'Hello!' }
          ]

          const result = await chatModel.invoke(messages)
          expect(result.content).to.exist

          await checkTraces
        })

        it('instruments a langchain openai chat model call for a BaseMessage-like input', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0].length).to.equal(1)
              const span = traces[0][0]

              expect(span.meta).to.have.property('langchain.request.provider', 'openai')
              expect(span.meta).to.have.property('langchain.request.model', 'gpt-4')
            })

          const chatModel = getLangChainOpenAiClient('chat', { model: 'gpt-4' })
          const messages = [
            new langchainMessages.SystemMessage('You only respond with one word answers'),
            new langchainMessages.HumanMessage('Hello!')
          ]
          const result = await chatModel.invoke(messages)

          expect(result.content).to.exist

          await checkTraces
        })

        it('instruments a langchain openai chat model call with tool calls', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0].length).to.equal(1)
              const span = traces[0][0]

              expect(span.meta).to.have.property('langchain.request.provider', 'openai')
              expect(span.meta).to.have.property('langchain.request.model', 'gpt-4')
            })

          const tools = [
            {
              type: 'function',
              function: {
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
            }
          ]

          const model = getLangChainOpenAiClient('chat', { model: 'gpt-4' })

          const modelWithTools = model.bindTools(tools)

          const result = await modelWithTools.invoke('My name is SpongeBob and I live in Bikini Bottom.')
          expect(result.tool_calls).to.have.length(1)
          expect(result.tool_calls[0].name).to.equal('extract_fictional_info')

          await checkTraces
        })

        it('instruments a langchain anthropic chat model call', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0].length).to.equal(1)
              const span = traces[0][0]

              expect(span).to.have.property('name', 'langchain.request')
              expect(span).to.have.property('resource', 'langchain.chat_models.anthropic.ChatAnthropic')

              expect(span.meta).to.have.property('langchain.request.provider', 'anthropic')
              expect(span.meta).to.have.property('langchain.request.model')
              expect(span.meta).to.have.property('langchain.request.type', 'chat_model')
            })

          const chatModel = getLangChainAnthropicClient('chat', { modelName: 'claude-3-5-sonnet-20241022' })

          const result = await chatModel.invoke('Hello!')
          expect(result.content).to.exist

          await checkTraces
        })
      })

      describe('chain', () => {
        it('does not tag output on error', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              expect(traces[0].length).to.equal(2)

              const chainSpan = traces[0][0]

              const langchainResponseRegex = /^langchain\.response\.outputs\./

              const hasMatching = Object.keys(chainSpan.meta).some(key => langchainResponseRegex.test(key))
              expect(hasMatching).to.be.false

              expect(chainSpan.meta).to.have.property('error.message')
              expect(chainSpan.meta).to.have.property('error.type')
              expect(chainSpan.meta).to.have.property('error.stack')
            })

          try {
            // use a bad model
            const model = getLangChainOpenAiClient('chat', { model: 'gpt-3.5-turbo-instruct', maxRetries: 0 })
            const parser = new langchainOutputParsers.StringOutputParser()

            const chain = model.pipe(parser)

            await chain.invoke('Hello!')
          } catch {}

          await checkTraces
        })

        it('instruments a langchain chain with a single openai chat model call', async () => {
          const checkTraces = agent
            .assertSomeTraces(traces => {
              const spans = traces[0]
              expect(spans).to.have.length(2)

              const chainSpan = spans[0]
              // we already check the chat model span in previous tests
              expect(spans[1]).to.have.property('resource', 'langchain.chat_models.openai.ChatOpenAI')

              expect(chainSpan).to.have.property('name', 'langchain.request')
              expect(chainSpan).to.have.property('resource', 'langchain_core.runnables.RunnableSequence')

              expect(chainSpan.meta).to.have.property('langchain.request.type', 'chain')
            })

          const model = getLangChainOpenAiClient('chat', { model: 'gpt-4' })
          const parser = new langchainOutputParsers.StringOutputParser()

          const chain = model.pipe(parser)
          const messages = [
            new langchainMessages.SystemMessage('You only respond with one word answers'),
            new langchainMessages.HumanMessage('Hello!')
          ]
          const result = await chain.invoke(messages)

          expect(result).to.exist

          await checkTraces
        })

        it('instruments a complex langchain chain', async () => {
          const prompt = langchainPrompts.ChatPromptTemplate.fromTemplate(
            'Tell me a short joke about {topic} in the style of {style}'
          )

          const model = getLangChainOpenAiClient('chat', { model: 'gpt-4' })

          const parser = new langchainOutputParsers.StringOutputParser()

          const chain = langchainRunnables.RunnableSequence.from([
            {
              topic: new langchainRunnables.RunnablePassthrough(),
              style: new langchainRunnables.RunnablePassthrough()
            },
            prompt,
            model,
            parser
          ])

          const checkTraces = agent
            .assertSomeTraces(traces => {
              const spans = traces[0]
              expect(spans).to.have.length(2)

              const chainSpan = spans[0]
              // we already check the chat model span in previous tests
              expect(spans[1]).to.have.property('resource', 'langchain.chat_models.openai.ChatOpenAI')

              expect(chainSpan.meta).to.have.property('langchain.request.type', 'chain')
            })

          const result = await chain.invoke({ topic: 'chickens', style: 'dad joke' })

          expect(result).to.exist

          await checkTraces
        })

        it('instruments a batched call', async () => {
          const prompt = langchainPrompts.ChatPromptTemplate.fromTemplate(
            'Tell me a joke about {topic}'
          )
          const parser = new langchainOutputParsers.StringOutputParser()
          const model = getLangChainOpenAiClient('chat', { model: 'gpt-4' })

          const chain = langchainRunnables.RunnableSequence.from([
            {
              topic: new langchainRunnables.RunnablePassthrough()
            },
            prompt,
            model,
            parser
          ])

          const checkTraces = agent
            .assertSomeTraces(traces => {
              const spans = traces[0]
              expect(spans).to.have.length(3) // 1 chain + 2 chat model

              const chainSpan = spans[0]

              expect(chainSpan.meta).to.have.property('langchain.request.type', 'chain')
            })

          const result = await chain.batch(['chickens', 'dogs'])

          expect(result).to.have.length(2)
          expect(result[0]).to.exist
          expect(result[1]).to.exist

          await checkTraces
        })

        it('instruments a chain with a JSON output parser and tags it correctly', async function () {
          if (!langchainOutputParsers.JsonOutputParser) this.skip()

          const checkTraces = agent
            .assertSomeTraces(traces => {
              const spans = traces[0]
              expect(spans).to.have.length(2) // 1 chain + 1 chat model

              const chainSpan = spans[0]

              expect(chainSpan.meta).to.have.property('langchain.request.type', 'chain')
            })

          const parser = new langchainOutputParsers.JsonOutputParser()
          const model = getLangChainOpenAiClient('chat', { model: 'gpt-3.5-turbo' })

          const chain = model.pipe(parser)

          const response = await chain.invoke('Generate a JSON object with name and age.')
          expect(response).to.exist.and.be.an('object')

          await checkTraces
        })
      })

      describe('embeddings', () => {
        describe('@langchain/openai', () => {
          it('does not tag output on error', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0].length).to.equal(1)

                const span = traces[0][0]

                expect(span.meta).to.not.have.property('langchain.response.outputs.embedding_length')

                expect(span.meta).to.have.property('error.message')
                expect(span.meta).to.have.property('error.type')
                expect(span.meta).to.have.property('error.stack')
              })

            try {
              // use a bad model
              const embeddings = getLangChainOpenAiClient('embedding', { model: 'gpt-3.5-turbo-instruct' })
              await embeddings.embedQuery('Hello, world!')
            } catch {}

            await checkTraces
          })

          it('instruments a langchain openai embedQuery call', async () => {
            const embeddings = getLangChainOpenAiClient('embedding')

            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0].length).to.equal(1)
                const span = traces[0][0]

                expect(span).to.have.property('name', 'langchain.request')
                expect(span).to.have.property('resource', 'langchain.embeddings.openai.OpenAIEmbeddings')

                expect(span.meta).to.have.property('langchain.request.provider', 'openai')
                expect(span.meta).to.have.property('langchain.request.model', 'text-embedding-ada-002')
                expect(span.meta).to.have.property('langchain.request.type', 'embedding')
              })

            const query = 'Hello, world!'
            const result = await embeddings.embedQuery(query)

            expect(result).to.have.length(1536)

            await checkTraces
          })

          it('instruments a langchain openai embedDocuments call', async () => {
            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0].length).to.equal(1)
                const span = traces[0][0]

                expect(span.meta).to.have.property('langchain.request.type', 'embedding')
                expect(span.meta).to.have.property('langchain.request.provider', 'openai')
                expect(span.meta).to.have.property('langchain.request.model', 'text-embedding-ada-002')
              })

            const embeddings = getLangChainOpenAiClient('embedding')

            const documents = ['Hello, world!', 'Goodbye, world!']
            const result = await embeddings.embedDocuments(documents)

            expect(result).to.have.length(2)
            expect(result[0]).to.have.length(1536)
            expect(result[1]).to.have.length(1536)

            await checkTraces
          })
        })

        describe('@langchain/google-genai', () => {
          it('instruments a langchain google-genai embedQuery call', async function () {
            if (!langchainGoogleGenAI) this.skip()

            const embeddings = getLangChainGoogleGenAIClient('embedding', {
              model: 'text-embedding-004',
              taskType: 'RETRIEVAL_DOCUMENT',
              title: 'Document title'
            })

            const checkTraces = agent
              .assertSomeTraces(traces => {
                expect(traces[0].length).to.equal(1)

                const span = traces[0][0]
                expect(span).to.have.property('name', 'langchain.request')
                expect(span).to.have.property('resource', 'langchain.embeddings.GoogleGenerativeAIEmbeddings')

                expect(span.meta).to.have.property('langchain.request.provider', 'googlegenerativeai')
                expect(span.meta).to.have.property('langchain.request.model', 'text-embedding-004')
                expect(span.meta).to.have.property('langchain.request.type', 'embedding')
              })

            const query = 'Hello, world!'
            const result = await embeddings.embedQuery(query)
            expect(result).to.have.length(768)

            await checkTraces
          })
        })
      })

      describe('tools', () => {
        it('traces a tool call', async function () {
          if (!langchainTools?.tool) this.skip()

          const myTool = langchainTools.tool(
            () => 'Hello, world!',
            {
              name: 'myTool',
              description: 'A tool that returns a greeting'
            }
          )

          const checkTraces = agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            expect(span).to.have.property('name', 'langchain.request')
            expect(span.resource).to.match(/^langchain\.tools\.[^.]+\.myTool$/)
          })
          const result = await myTool.invoke()
          expect(result).to.equal('Hello, world!')

          await checkTraces
        })

        it('traces a tool call with an error', async function () {
          if (!langchainTools?.tool) this.skip()

          const myTool = langchainTools.tool(
            () => { throw new Error('This is a test error') },
            {
              name: 'myTool',
              description: 'A tool that throws an error'
            }
          )

          const checkTraces = agent.assertSomeTraces(traces => {
            const span = traces[0][0]

            expect(span).to.have.property('name', 'langchain.request')
            expect(span.resource).to.match(/^langchain\.tools\.[^.]+\.myTool$/)

            expect(span.meta).to.have.property('error.message')
            expect(span.meta).to.have.property('error.type')
            expect(span.meta).to.have.property('error.stack')
          })

          try {
            await myTool.invoke()
            expect.fail('Expected an error to be thrown')
          } catch {}

          await checkTraces
        })
      })

      describe('vectorstores', () => {
        let vectorstore

        beforeEach(async () => {
          const embeddings = getLangChainOpenAiClient('embedding')
          vectorstore = new MemoryVectorStore(embeddings)

          const document = {
            pageContent: 'The powerhouse of the cell is the mitochondria',
            metadata: { source: 'https://example.com' },
            id: '1'
          }

          return vectorstore.addDocuments([document])
        })

        it('traces a vectorstore similaritySearch call', async () => {
          const checkTraces = agent.assertSomeTraces(traces => {
            const spans = traces[0]

            expect(spans).to.have.length(2)

            const vectorstoreSpan = spans[0]
            const embeddingSpan = spans[1]

            expect(vectorstoreSpan).to.have.property('name', 'langchain.request')
            expect(vectorstoreSpan).to.have.property('resource', 'langchain.vectorstores.memory.MemoryVectorStore')

            expect(embeddingSpan).to.have.property('name', 'langchain.request')
            expect(embeddingSpan).to.have.property('resource', 'langchain.embeddings.openai.OpenAIEmbeddings')
          }, { spanResourceMatch: /langchain\.vectorstores\.memory\.MemoryVectorStore/ })
          // we need the spanResourceMatch, otherwise we'll match from the beforeEach

          const result = await vectorstore.similaritySearch('The powerhouse of the cell is the mitochondria', 2)
          expect(result).to.exist

          await checkTraces
        })

        it('traces a vectorstore similaritySearchWithScore call', async () => {
          const checkTraces = agent.assertSomeTraces(traces => {
            const spans = traces[0]

            expect(spans).to.have.length(2)

            const vectorstoreSpan = spans[0]
            const embeddingSpan = spans[1]

            expect(vectorstoreSpan).to.have.property('name', 'langchain.request')
            expect(vectorstoreSpan).to.have.property('resource', 'langchain.vectorstores.memory.MemoryVectorStore')

            expect(embeddingSpan).to.have.property('name', 'langchain.request')
            expect(embeddingSpan).to.have.property('resource', 'langchain.embeddings.openai.OpenAIEmbeddings')
          }, { spanResourceMatch: /langchain\.vectorstores\.memory\.MemoryVectorStore/ })
          // we need the spanResourceMatch, otherwise we'll match from the beforeEach

          const result = await vectorstore.similaritySearchWithScore(
            'The powerhouse of the cell is the mitochondria', 2
          )
          expect(result).to.exist

          await checkTraces
        })
      })
    })
  })
})
