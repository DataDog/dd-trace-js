'use strict'

const { describe, it, beforeEach, before, after } = require('mocha')

const { useEnv } = require('../../../../../../integration-tests/helpers')
const iastFilter = require('../../../../src/appsec/iast/taint-tracking/filter')
const { withVersions } = require('../../../setup/mocha')
const assert = require('node:assert')

const {
  assertLlmObsSpanEvent,
  MOCK_ANY,
  MOCK_STRING,
  useLlmObs
} = require('../../util')

const isDdTrace = iastFilter.isDdTrace

describe('integrations', () => {
  let langchainOpenai
  let langchainAnthropic
  let langchainCohere

  let langchainMessages
  let langchainOutputParsers
  let langchainPrompts
  let langchainRunnables
  let tool
  let MemoryVectorStore

  let llmobs

  useEnv({
    OPENAI_API_KEY: '<not-a-real-key>',
    ANTHROPIC_API_KEY: '<not-a-real-key>',
    COHERE_API_KEY: '<not-a-real-key>'
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

  describe('langchain', () => {
    const getEvents = useLlmObs({ plugin: 'langchain' })

    before(async () => {
      iastFilter.isDdTrace = file => {
        if (file.includes('dd-trace-js/versions/')) {
          return false
        }
        return isDdTrace(file)
      }

      llmobs = require('../../../../../..').llmobs
    })

    after(() => {
      iastFilter.isDdTrace = isDdTrace
    })

    withVersions('langchain', ['@langchain/core'], version => {
      describe('langchain', () => {
        beforeEach(() => {
          langchainOpenai = require(`../../../../../../versions/langchain@${version}`)
            .get('@langchain/openai')
          langchainAnthropic = require(`../../../../../../versions/@langchain/anthropic@${version}`).get()
          langchainCohere = require(`../../../../../../versions/@langchain/cohere@${version}`).get()

          // need to specify specific import in `get(...)`
          langchainMessages = require(`../../../../../../versions/@langchain/core@${version}`)
            .get('@langchain/core/messages')
          langchainOutputParsers = require(`../../../../../../versions/@langchain/core@${version}`)
            .get('@langchain/core/output_parsers')
          langchainPrompts = require(`../../../../../../versions/@langchain/core@${version}`)
            .get('@langchain/core/prompts')
          langchainRunnables = require(`../../../../../../versions/@langchain/core@${version}`)
            .get('@langchain/core/runnables')

          tool = require(`../../../../../../versions/@langchain/core@${version}`)
            .get('@langchain/core/tools')
            .tool

          MemoryVectorStore = require(`../../../../../../versions/@langchain/core@${version}`)
            .get('langchain/vectorstores/memory')
            .MemoryVectorStore
        })

        describe('llm', () => {
          it('submits an llm span for an openai llm call', async () => {
            const llm = getLangChainOpenAiClient('llm', { model: 'gpt-3.5-turbo-instruct' })

            await llm.invoke('What is 2 + 2?')

            const { apmSpans, llmobsSpans } = await getEvents()

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'llm',
              modelName: 'gpt-3.5-turbo-instruct',
              modelProvider: 'openai',
              name: 'langchain.llms.openai.OpenAI',
              inputData: [{ content: 'What is 2 + 2?' }],
              outputData: [{ content: '\n\n4' }],
              metadata: MOCK_ANY,
              metrics: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
              tags: { ml_app: 'test', integration: 'langchain' }
            })
          })

          it('does not tag output if there is an error', async () => {
            const llm = new langchainOpenai.OpenAI({ model: 'text-embedding-3-small', maxRetries: 0 })

            try {
              await llm.invoke('Hello!')
            } catch {}

            const { apmSpans, llmobsSpans } = await getEvents()
            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'llm',
              modelName: 'text-embedding-3-small',
              modelProvider: 'openai',
              name: 'langchain.llms.openai.OpenAI',
              inputData: [{ content: 'Hello!' }],
              outputData: [{ content: '' }],
              metadata: MOCK_ANY,
              tags: { ml_app: 'test', integration: 'langchain' },
              error: {
                type: 'Error',
                message: MOCK_STRING,
                stack: MOCK_ANY
              }
            })
          })

          it('submits an llm span for a cohere call', async function () {
            if (version === '0.1.0') this.skip() // cannot patch client to mock response on lower versions

            const cohere = new langchainCohere.Cohere({
              model: 'command',
              client: {
                generate () {
                  return {
                    generations: [
                      {
                        text: 'hello world!'
                      }
                    ],
                    meta: {
                      billed_units: {
                        input_tokens: 8,
                        output_tokens: 12
                      }
                    }
                  }
                }
              }
            })

            await cohere.invoke('Hello!')

            const { apmSpans, llmobsSpans } = await getEvents()
            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'llm',
              modelName: 'command',
              modelProvider: 'cohere',
              name: 'langchain.llms.cohere.Cohere',
              inputData: [{ content: 'Hello!' }],
              outputData: [{ content: 'hello world!' }],
              metadata: MOCK_ANY,
              // @langchain/cohere does not provide token usage in the response
              metrics: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
              tags: { ml_app: 'test', integration: 'langchain' }
            })
          })
        })

        describe('chat model', () => {
          it('submits an llm span for an openai chat model call', async () => {
            const chat = getLangChainOpenAiClient('chat', { model: 'gpt-3.5-turbo' })

            await chat.invoke('What is 2 + 2?')

            const { apmSpans, llmobsSpans } = await getEvents()
            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'llm',
              modelName: 'gpt-3.5-turbo',
              modelProvider: 'openai',
              name: 'langchain.chat_models.openai.ChatOpenAI',
              inputData: [{ content: 'What is 2 + 2?', role: 'user' }],
              outputData: [{ content: '2 + 2 = 4', role: 'assistant' }],
              metadata: MOCK_ANY,
              metrics: { input_tokens: 15, output_tokens: 7, total_tokens: 22 },
              tags: { ml_app: 'test', integration: 'langchain' }
            })
          })

          it('does not tag output if there is an error', async () => {
            const chat = new langchainOpenai.ChatOpenAI({ model: 'gpt-3.5-turbo-instruct', maxRetries: 0 })

            try {
              await chat.invoke('Hello!')
            } catch {}

            const { apmSpans, llmobsSpans } = await getEvents()
            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'llm',
              modelName: 'gpt-3.5-turbo-instruct',
              modelProvider: 'openai',
              name: 'langchain.chat_models.openai.ChatOpenAI',
              inputData: [{ content: 'Hello!', role: 'user' }],
              outputData: [{ content: '' }],
              metadata: MOCK_ANY,
              tags: { ml_app: 'test', integration: 'langchain' },
              error: {
                type: 'Error',
                message: MOCK_STRING,
                stack: MOCK_ANY
              }
            })
          })

          it('submits an llm span for an anthropic chat model call', async () => {
            const chatModel = getLangChainAnthropicClient('chat', { modelName: 'claude-3-5-sonnet-20241022' })

            await chatModel.invoke('Hello!')

            const { apmSpans, llmobsSpans } = await getEvents()
            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'llm',
              modelName: 'claude-3-5-sonnet-20241022',
              modelProvider: 'anthropic',
              name: 'langchain.chat_models.anthropic.ChatAnthropic',
              inputData: [{ content: 'Hello!', role: 'user' }],
              outputData: [{ content: 'Hi there! How can I help you today?', role: 'assistant' }],
              metadata: MOCK_ANY,
              metrics: { input_tokens: 9, output_tokens: 13, total_tokens: 22 },
              tags: { ml_app: 'test', integration: 'langchain' }
            })
          })

          it('submits an llm span with tool calls', async () => {
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

            await modelWithTools.invoke('My name is SpongeBob and I live in Bikini Bottom.')

            const { apmSpans, llmobsSpans } = await getEvents()
            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'llm',
              modelName: 'gpt-4',
              modelProvider: 'openai',
              name: 'langchain.chat_models.openai.ChatOpenAI',
              inputData: [{ content: 'My name is SpongeBob and I live in Bikini Bottom.', role: 'user' }],
              outputData: [{
                content: '',
                role: 'assistant',
                tool_calls: [{
                  arguments: {
                    name: 'SpongeBob',
                    origin: 'Bikini Bottom'
                  },
                  name: 'extract_fictional_info'
                }]
              }],
              metadata: MOCK_ANY,
              metrics: { input_tokens: 82, output_tokens: 31, total_tokens: 113 },
              tags: { ml_app: 'test', integration: 'langchain' }
            })
          })
        })

        describe('embedding', () => {
          it('submits an embedding span for an `embedQuery` call', async () => {
            const embeddings = getLangChainOpenAiClient('embedding')

            await embeddings.embedQuery('Hello, world!')

            const { apmSpans, llmobsSpans } = await getEvents()
            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'embedding',
              modelName: 'text-embedding-ada-002',
              modelProvider: 'openai',
              name: 'langchain.embeddings.openai.OpenAIEmbeddings',
              inputData: [{ text: 'Hello, world!' }],
              outputData: '[1 embedding(s) returned with size 1536]',
              metadata: MOCK_ANY,
              tags: { ml_app: 'test', integration: 'langchain' }
            })
          })

          it('does not tag output if there is an error', async () => {
            const embeddings = getLangChainOpenAiClient('embedding', { model: 'gpt-3.5-turbo-instruct' })

            try {
              await embeddings.embedQuery('Hello, world!')
            } catch {}

            const { apmSpans, llmobsSpans } = await getEvents()
            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'embedding',
              modelName: 'gpt-3.5-turbo-instruct',
              modelProvider: 'openai',
              name: 'langchain.embeddings.openai.OpenAIEmbeddings',
              inputData: [{ text: 'Hello, world!' }],
              metadata: MOCK_ANY,
              tags: { ml_app: 'test', integration: 'langchain' },
              error: {
                type: 'Error',
                message: MOCK_STRING,
                stack: MOCK_ANY
              }
            })
          })

          it('submits an embedding span for an `embedDocuments` call', async () => {
            const embeddings = getLangChainOpenAiClient('embedding')

            await embeddings.embedDocuments(['Hello, world!', 'Goodbye, world!'])

            const { apmSpans, llmobsSpans } = await getEvents()
            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'embedding',
              modelName: 'text-embedding-ada-002',
              modelProvider: 'openai',
              name: 'langchain.embeddings.openai.OpenAIEmbeddings',
              inputData: [{ text: 'Hello, world!' }, { text: 'Goodbye, world!' }],
              outputData: '[2 embedding(s) returned with size 1536]',
              metadata: MOCK_ANY,
              tags: { ml_app: 'test', integration: 'langchain' }
            })
          })
        })

        describe('chain', () => {
          it('submits a workflow and llm spans for a simple chain call', async () => {
            const prompt = langchainPrompts.ChatPromptTemplate.fromMessages([
              ['system', 'You are a world class technical documentation writer'],
              ['user', '{input}']
            ])

            const llm = getLangChainOpenAiClient('llm', { model: 'gpt-3.5-turbo-instruct' })

            const chain = prompt.pipe(llm)

            await chain.invoke({ input: 'Can you tell me about LangSmith?' })

            const { apmSpans, llmobsSpans } = await getEvents()

            const workflowSpan = apmSpans[0]
            const llmSpan = apmSpans[1]

            const expectedOutput = '\n\nSystem: LangSmith is a top-of-the-line software that caters to the needs ' +
            'of technical writers like you. It offers a user-friendly interface, advanced formatting tools, and ' +
            'collaboration features to help you create high-quality technical documents with ease. With LangSmith, ' +
            'you can produce professional-looking manuals, guides, and tutorials that will impress even the most ' +
            'discerning clients. Its robust features and intuitive design make it the go-to tool for ' +
            'technical writers all over the world.'

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: workflowSpan,
              spanKind: 'workflow',
              name: 'langchain_core.runnables.RunnableSequence',
              inputData: JSON.stringify({ input: 'Can you tell me about LangSmith?' }),
              outputData: expectedOutput,
              tags: { ml_app: 'test', integration: 'langchain' }
            })

            assertLlmObsSpanEvent(llmobsSpans[1], {
              span: llmSpan,
              parentId: workflowSpan.span_id,
              spanKind: 'llm',
              modelName: 'gpt-3.5-turbo-instruct',
              modelProvider: 'openai',
              name: 'langchain.llms.openai.OpenAI',
              inputData: [{
                content: 'System: You are a world class technical documentation writer\n' +
                'Human: Can you tell me about LangSmith?'
              }],
              outputData: [{ content: expectedOutput }],
              metadata: MOCK_ANY,
              metrics: { input_tokens: 21, output_tokens: 94, total_tokens: 115 },
              tags: { ml_app: 'test', integration: 'langchain' }
            })
          })

          it('does not tag output if there is an error', async () => {
            const llm = getLangChainOpenAiClient('llm', { model: 'text-embedding-3-small', maxRetries: 0 })
            const parser = new langchainOutputParsers.StringOutputParser()
            const chain = llm.pipe(parser)

            try {
              await chain.invoke('Hello!')
            } catch {}

            const { apmSpans, llmobsSpans } = await getEvents()
            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'workflow',
              name: 'langchain_core.runnables.RunnableSequence',
              inputData: 'Hello!',
              tags: { ml_app: 'test', integration: 'langchain' },
              error: {
                type: 'Error',
                message: MOCK_STRING,
                stack: MOCK_ANY
              }
            })
          })

          it('submits workflow and llm spans for a nested chain', async () => {
            const firstPrompt = langchainPrompts.ChatPromptTemplate.fromTemplate('what is the city {person} is from?')
            const secondPrompt = langchainPrompts.ChatPromptTemplate.fromTemplate(
              'what country is the city {city} in? respond in {language}'
            )

            const model = getLangChainOpenAiClient('chat', { model: 'gpt-3.5-turbo' })
            const parser = new langchainOutputParsers.StringOutputParser()

            const firstChain = firstPrompt.pipe(model).pipe(parser)
            const secondChain = secondPrompt.pipe(model).pipe(parser)

            const completeChain = langchainRunnables.RunnableSequence.from([
              {
                city: firstChain,
                language: input => input.language
              },
              secondChain
            ])

            const result = await llmobs.annotationContext({ tags: { foo: 'bar' } }, () => {
              return completeChain.invoke({ person: 'Abraham Lincoln', language: 'Spanish' })
            })
            assert.ok(result)

            const { apmSpans, llmobsSpans } = await getEvents()

            const topLevelWorkflow = apmSpans[0]
            const firstSubWorkflow = apmSpans[1]
            const firstLLM = apmSpans[2]
            const secondSubWorkflow = apmSpans[3]
            const secondLLM = apmSpans[4]

            const expectedOutput = 'Abraham Lincoln nació en Hodgenville, Kentucky. ' +
            'Más tarde vivió en Springfield, Illinois, que se asocia frecuentemente con él como su ciudad natal.'

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: topLevelWorkflow,
              spanKind: 'workflow',
              name: 'langchain_core.runnables.RunnableSequence',
              inputData: JSON.stringify({ person: 'Abraham Lincoln', language: 'Spanish' }),
              outputData: expectedOutput,
              tags: { ml_app: 'test', integration: 'langchain', foo: 'bar' }
            })

            assertLlmObsSpanEvent(llmobsSpans[1], {
              span: firstSubWorkflow,
              parentId: topLevelWorkflow.span_id,
              spanKind: 'workflow',
              name: 'langchain_core.runnables.RunnableSequence',
              inputData: JSON.stringify({ person: 'Abraham Lincoln', language: 'Spanish' }),
              outputData: 'Abraham Lincoln was born in Hodgenville, Kentucky. He later lived ' +
              'in Springfield, Illinois, which is often associated with him as his home city.',
              tags: { ml_app: 'test', integration: 'langchain', foo: 'bar' }
            })

            assertLlmObsSpanEvent(llmobsSpans[2], {
              span: firstLLM,
              parentId: firstSubWorkflow.span_id,
              spanKind: 'llm',
              modelName: 'gpt-3.5-turbo',
              modelProvider: 'openai',
              name: 'langchain.chat_models.openai.ChatOpenAI',
              inputData: [
                { content: 'what is the city Abraham Lincoln is from?', role: 'user' }
              ],
              outputData: [{
                content: 'Abraham Lincoln was born in Hodgenville, Kentucky. He later lived ' +
              'in Springfield, Illinois, which is often associated with him as his home city.',
                role: 'assistant'
              }],
              metadata: MOCK_ANY,
              metrics: { input_tokens: 16, output_tokens: 30, total_tokens: 46 },
              tags: { ml_app: 'test', integration: 'langchain', foo: 'bar' }
            })

            assertLlmObsSpanEvent(llmobsSpans[3], {
              span: secondSubWorkflow,
              parentId: topLevelWorkflow.span_id,
              spanKind: 'workflow',
              name: 'langchain_core.runnables.RunnableSequence',
              inputData: JSON.stringify({
                language: 'Spanish',
                city: 'Abraham Lincoln was born in Hodgenville, Kentucky. He later lived in ' +
                'Springfield, Illinois, which is often associated with him as his home city.'
              }),
              outputData: expectedOutput,
              tags: { ml_app: 'test', integration: 'langchain', foo: 'bar' }
            })

            assertLlmObsSpanEvent(llmobsSpans[4], {
              span: secondLLM,
              parentId: secondSubWorkflow.span_id,
              spanKind: 'llm',
              modelName: 'gpt-3.5-turbo',
              modelProvider: 'openai',
              name: 'langchain.chat_models.openai.ChatOpenAI',
              inputData: [
                {
                  content: 'what country is the city Abraham Lincoln was born in Hodgenville, Kentucky. ' +
                  'He later lived in Springfield, Illinois, which is often associated with him as his home city. ' +
                  'in? respond in Spanish',
                  role: 'user'
                }
              ],
              outputData: [{ content: expectedOutput, role: 'assistant' }],
              metadata: MOCK_ANY,
              metrics: { input_tokens: 46, output_tokens: 37, total_tokens: 83 },
              tags: { ml_app: 'test', integration: 'langchain', foo: 'bar' }
            })
          })

          // TODO(sabrenner): this test seems flaky with VCR, will need to investigate
          // when it doesn't flake, it does pass, it's just a test infra problem
          it.skip('submits workflow and llm spans for a batched chain', async () => {
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

            await chain.batch(['chickens', 'dogs'])

            const { apmSpans, llmobsSpans } = await getEvents()

            const workflowSpan = apmSpans[0]
            const firstLLMSpan = apmSpans[1]
            const secondLLMSpan = apmSpans[2]

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: workflowSpan,
              spanKind: 'workflow',
              name: 'langchain_core.runnables.RunnableSequence',
              inputData: JSON.stringify(['chickens', 'dogs']),
              outputData: JSON.stringify([
                "Why don't chickens use Facebook?\n\nBecause they already know what everyone's clucking about!",
                'Why did the scarecrow adopt a dog?\n\nBecause he needed a "barking" buddy!']
              ),
              tags: { ml_app: 'test', integration: 'langchain' }
            })

            assertLlmObsSpanEvent(llmobsSpans[1], {
              span: firstLLMSpan,
              parentId: workflowSpan.span_id,
              spanKind: 'llm',
              modelName: 'gpt-4',
              modelProvider: 'openai',
              name: 'langchain.chat_models.openai.ChatOpenAI',
              inputData: [{ content: 'Tell me a joke about chickens', role: 'user' }],
              outputData: [{
                content: "Why don't chickens use Facebook?\n\nBecause " +
                "they already know what everyone's clucking about!",
                role: 'assistant'
              }],
              metadata: MOCK_ANY,
              metrics: { input_tokens: 13, output_tokens: 18, total_tokens: 31 },
              tags: { ml_app: 'test', integration: 'langchain' }
            })

            assertLlmObsSpanEvent(llmobsSpans[2], {
              span: secondLLMSpan,
              parentId: workflowSpan.span_id,
              spanKind: 'llm',
              modelName: 'gpt-4',
              modelProvider: 'openai',
              name: 'langchain.chat_models.openai.ChatOpenAI',
              inputData: [{ content: 'Tell me a joke about dogs', role: 'user' }],
              outputData: [{
                content: 'Why did the scarecrow adopt a dog?\n\nBecause he needed a "barking" buddy!',
                role: 'assistant'
              }],
              metadata: MOCK_ANY,
              metrics: { input_tokens: 13, output_tokens: 19, total_tokens: 32 },
              tags: { ml_app: 'test', integration: 'langchain' }
            })
          })

          it('submits a workflow and llm spans for different schema IO', async () => {
            const prompt = langchainPrompts.ChatPromptTemplate.fromMessages([
              ['system', 'You are an assistant who is good at {ability}. Respond in 20 words or fewer'],
              new langchainPrompts.MessagesPlaceholder('history'),
              ['human', '{input}']
            ])

            const model = getLangChainOpenAiClient('chat', { model: 'gpt-3.5-turbo' })
            const chain = prompt.pipe(model)

            await chain.invoke({
              ability: 'world capitals',
              history: [
                new langchainMessages.HumanMessage('Can you be my science teacher instead?'),
                new langchainMessages.AIMessage('Yes')
              ],
              input: 'What is the powerhouse of the cell?'
            })

            const { apmSpans, llmobsSpans } = await getEvents()

            const workflowSpan = apmSpans[0]
            const llmSpan = apmSpans[1]

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: workflowSpan,
              spanKind: 'workflow',
              name: 'langchain_core.runnables.RunnableSequence',
              inputData: JSON.stringify({
                ability: 'world capitals',
                history: [
                  {
                    content: 'Can you be my science teacher instead?',
                    role: 'user'
                  },
                  {
                    content: 'Yes',
                    role: 'assistant'
                  }
                ],
                input: 'What is the powerhouse of the cell?'
              }),
              // takes the form of an AIMessage struct since there is no output parser
              outputData: JSON.stringify({
                content: 'Mitochondria',
                role: 'assistant'
              }),
              tags: { ml_app: 'test', integration: 'langchain' }
            })

            assertLlmObsSpanEvent(llmobsSpans[1], {
              span: llmSpan,
              parentId: workflowSpan.span_id,
              spanKind: 'llm',
              modelName: 'gpt-3.5-turbo',
              modelProvider: 'openai',
              name: 'langchain.chat_models.openai.ChatOpenAI',
              inputData: [
                {
                  content: 'You are an assistant who is good at world capitals. Respond in 20 words or fewer',
                  role: 'system'
                },
                {
                  content: 'Can you be my science teacher instead?',
                  role: 'user'
                },
                {
                  content: 'Yes',
                  role: 'assistant'
                },
                {
                  content: 'What is the powerhouse of the cell?',
                  role: 'user'
                }
              ],
              outputData: [{ content: 'Mitochondria', role: 'assistant' }],
              metadata: MOCK_ANY,
              metrics: { input_tokens: 54, output_tokens: 3, total_tokens: 57 },
              tags: { ml_app: 'test', integration: 'langchain' }
            })
          })

          it('traces a manually-instrumented step', async () => {
            let lengthFunction = (input = { foo: '' }) => {
              llmobs.annotate({ inputData: input }) // so we don't try and tag `config` with auto-annotation
              return {
                length: input.foo.length.toString()
              }
            }
            lengthFunction = llmobs.wrap({ kind: 'task' }, lengthFunction)

            const model = getLangChainOpenAiClient('chat', { model: 'gpt-4o' })

            const prompt = langchainPrompts.ChatPromptTemplate.fromTemplate('What is {length} squared?')

            const chain = langchainRunnables.RunnableLambda.from(lengthFunction)
              .pipe(prompt)
              .pipe(model)
              .pipe(new langchainOutputParsers.StringOutputParser())

            await chain.invoke({ foo: 'bar' })

            const { apmSpans, llmobsSpans } = await getEvents()

            const workflowSpan = apmSpans[0]
            const taskSpan = apmSpans[1]
            const llmSpan = apmSpans[2]

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: workflowSpan,
              spanKind: 'workflow',
              name: 'langchain_core.runnables.RunnableSequence',
              inputData: JSON.stringify({ foo: 'bar' }),
              outputData: '3 squared is 9.',
              tags: { ml_app: 'test', integration: 'langchain' }
            })

            assertLlmObsSpanEvent(llmobsSpans[1], {
              span: taskSpan,
              parentId: workflowSpan.span_id,
              spanKind: 'task',
              name: 'lengthFunction',
              inputData: JSON.stringify({ foo: 'bar' }),
              outputData: JSON.stringify({ length: '3' }),
              tags: { ml_app: 'test' }
            })

            assertLlmObsSpanEvent(llmobsSpans[2], {
              span: llmSpan,
              parentId: workflowSpan.span_id,
              spanKind: 'llm',
              modelName: 'gpt-4o',
              modelProvider: 'openai',
              name: 'langchain.chat_models.openai.ChatOpenAI',
              inputData: [{ content: 'What is 3 squared?', role: 'user' }],
              outputData: [{ content: '3 squared is 9.', role: 'assistant' }],
              metadata: MOCK_ANY,
              metrics: { input_tokens: 13, output_tokens: 6, total_tokens: 19 },
              tags: { ml_app: 'test', integration: 'langchain' }
            })
          })
        })

        describe('tools', () => {
          it('submits a tool call span', async function () {
            if (!tool) this.skip()

            const add = tool(
              ({ a, b }) => a + b,
              {
                name: 'add',
                description: 'A tool that adds two numbers',
                schema: {
                  a: { type: 'number' },
                  b: { type: 'number' }
                }
              }
            )

            const result = await add.invoke({ a: 1, b: 2 })
            assert.equal(result, 3)

            const { apmSpans, llmobsSpans } = await getEvents()
            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'tool',
              name: 'add',
              inputData: JSON.stringify({ a: 1, b: 2 }),
              outputData: JSON.stringify(3),
              tags: { ml_app: 'test', integration: 'langchain' }
            })
          })

          it('submits a tool call with an error', async function () {
            if (!tool) this.skip()

            const add = tool(
              ({ a, b }) => {
                throw new Error('This is a test error')
              },
              {
                name: 'add',
                description: 'A tool that adds two numbers',
                schema: {
                  a: { type: 'number' },
                  b: { type: 'number' }
                }
              }
            )

            try {
              await add.invoke({ a: 1, b: 2 })
              assert.fail('Expected an error to be thrown')
            } catch {}

            const { apmSpans, llmobsSpans } = await getEvents()
            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'tool',
              name: 'add',
              inputData: JSON.stringify({ a: 1, b: 2 }),
              tags: { ml_app: 'test', integration: 'langchain' },
              error: {
                type: 'Error',
                message: 'This is a test error',
                stack: MOCK_ANY
              }
            })
          })
        })

        describe('vectorstores', () => {
          let vectorstore

          beforeEach(async () => {
            const embeddings = getLangChainOpenAiClient('embedding')
            vectorstore = new MemoryVectorStore(embeddings)

            const document = {
              pageContent: 'The powerhouse of the cell is the mitochondria',
              metadata: { source: 'https://example.com' }
            }

            await vectorstore.addDocuments([document])

            // simple assert that the embedding span was created
            // calling `getEvents` will also reset the traces promise for the upcoming tests
            const events = await getEvents()
            const embeddingSpanEvent = events.llmobsSpans[0]
            assert.ok(embeddingSpanEvent)
          })

          it('submits a retrieval span with a child embedding span for similaritySearch', async () => {
            await vectorstore.similaritySearch('Biology')

            const { apmSpans, llmobsSpans } = await getEvents()

            // first call was for the embedding span in the beforeEach
            const retrievalSpanEvent = llmobsSpans[0]
            const embeddingSpanEvent = llmobsSpans[1]

            assert.equal(embeddingSpanEvent.meta['span.kind'], 'embedding')
            assert.equal(embeddingSpanEvent.parent_id, retrievalSpanEvent.span_id)

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'retrieval',
              name: 'langchain.vectorstores.memory.MemoryVectorStore',
              inputData: 'Biology',
              outputData: [{
                text: 'The powerhouse of the cell is the mitochondria',
                name: 'https://example.com'
              }],
              tags: { ml_app: 'test', integration: 'langchain' }
            })
          })

          it('submits a retrieval span with a child embedding span for similaritySearchWithScore', async () => {
            await vectorstore.similaritySearchWithScore('Biology')

            const { apmSpans, llmobsSpans } = await getEvents()

            // first call was for the embedding span in the beforeEach
            const retrievalSpanEvent = llmobsSpans[0]
            const embeddingSpanEvent = llmobsSpans[1]

            assert.equal(embeddingSpanEvent.meta['span.kind'], 'embedding')
            assert.equal(embeddingSpanEvent.parent_id, retrievalSpanEvent.span_id)

            assertLlmObsSpanEvent(llmobsSpans[0], {
              span: apmSpans[0],
              spanKind: 'retrieval',
              name: 'langchain.vectorstores.memory.MemoryVectorStore',
              inputData: 'Biology',
              outputData: [{
                text: 'The powerhouse of the cell is the mitochondria',
                name: 'https://example.com',
                score: 0.7882083567178202
              }],
              tags: { ml_app: 'test', integration: 'langchain' }
            })
          })
        })
      })
    })
  })
})
