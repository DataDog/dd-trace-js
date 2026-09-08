'use strict'

const path = require('node:path')
const { finish, loadTracer } = require('../common')

const ROOT = path.resolve(__dirname, '../../../../../../../')
const sdkPackage = path.join(ROOT, 'versions/@aws-sdk/client-bedrock-runtime')

const models = {
  'invoke-anthropic-messages': 'us.anthropic.claude-3-sonnet-20240229-v1:0',
  'invoke-anthropic-tool-use': 'anthropic.claude-3-sonnet-20240229-v1:0',
  'invoke-amazon-titan': 'amazon.titan-tg1-large',
  'invoke-amazon-nova': 'amazon.nova-pro-v1:0',
  'invoke-meta': 'meta.llama2-13b-chat-v1',
  'invoke-cohere-multi-output': 'cohere.command-light-text-v14',
  'invoke-mistral': 'mistral.mistral-7b-instruct-v0:2',
  'invoke-error': 'meta.llama2-13b-chat-v1',
  'embed-amazon': 'amazon.titan-embed-text-v1',
  'embed-cohere': 'cohere.embed-english-v3',
  converse: 'anthropic.claude-3-sonnet-20240229-v1:0',
  'converse-tool-use': 'anthropic.claude-3-sonnet-20240229-v1:0',
  'converse-prompt-caching': 'us.anthropic.claude-3-7-sonnet-20250219-v1:0',
  'converse-error': 'anthropic.claude-3-sonnet-20240229-v1:0',
  'converse-inference-profile': 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/1arbu5hu2sjr',
}

function invokeBody (scenario) {
  if (scenario.startsWith('invoke-anthropic')) {
    return {
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'summarize the plot to the lord of the rings in a dozen words' }],
      }],
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 50,
      temperature: 0,
      ...(scenario === 'invoke-anthropic-tool-use'
        ? {
            tools: [{
              name: 'get_weather',
              description: 'Get the current weather.',
              input_schema: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
            }],
          }
        : {}),
    }
  }
  if (scenario.startsWith('invoke-amazon')) {
    return {
      inputText: 'Command: can you explain what Datadog is to someone not in the tech industry?',
      textGenerationConfig: { maxTokenCount: 50, stopSequences: [], temperature: 0, topP: 0.9 },
    }
  }
  if (scenario === 'invoke-meta' || scenario === 'invoke-error') {
    return { prompt: "What does 'lorem ipsum' mean?", temperature: 0.9, top_p: 1.0, max_gen_len: 60 }
  }
  if (scenario.startsWith('invoke-cohere')) {
    return {
      prompt: '\n\nHuman: %s\n\nAssistant: Can you explain what a LLM chain is?',
      temperature: 0.9,
      p: 1.0,
      k: 0,
      max_tokens: 10,
      stop_sequences: [],
      stream: false,
      num_generations: 2,
    }
  }
  return { prompt: 'Explain distributed tracing in one sentence.', max_tokens: 64, temperature: 0.5 }
}

function converseBody (scenario) {
  if (scenario === 'converse-error') {
    return {
      messages: [{
        role: 'user',
        content: [{ text: 'Explain the concept of distributed tracing in a simple way' }],
      }],
      inferenceConfig: { temperature: 0.7, topP: 0.9, maxTokens: 50, stopSequences: [] },
    }
  }
  if (scenario === 'converse-inference-profile') {
    return {
      messages: [{
        role: 'user',
        content: [{ text: 'Explain distributed tracing in one sentence.' }],
      }],
      inferenceConfig: { maxTokens: 100, temperature: 0 },
    }
  }
  const body = {
    messages: [{ role: 'user', content: [{ text: 'Explain the concept of distributed tracing in a simple way' }] }],
    system: [{ text: 'You are an expert swe that is to use the tool fetch_concept' }],
    inferenceConfig: { temperature: 0.7, topP: 0.9, maxTokens: 1000, stopSequences: [] },
    toolConfig: {
      tools: [{
        toolSpec: {
          name: 'fetch_concept',
          description: 'Fetch an expert explanation for a concept, especially relevant for technical concepts ' +
            'like distributed tracing',
          inputSchema: {
            json: {
              type: 'object',
              properties: { concept: { type: 'string', description: 'The concept to explain' } },
              required: ['concept'],
            },
          },
        },
      }],
    },
  }
  if (scenario === 'converse-tool-use') {
    body.messages = [
      {
        role: 'assistant',
        content: [{ toolUse: { toolUseId: 'tool-1', name: 'get_weather', input: { city: 'Paris' } } }],
      },
      {
        role: 'user',
        content: [
          { text: 'Here is the tool result.' },
          { toolResult: { toolUseId: 'tool-1', content: [{ text: 'Sunny.' }, { json: { temperature: 22 } }] } },
          { document: { name: 'context.txt', source: { bytes: 'placeholder' }, format: 'txt' } },
        ],
      },
    ]
    body.toolConfig = {
      tools: [{
        toolSpec: {
          name: 'get_weather',
          description: 'Get the current weather.',
          inputSchema: { json: { type: 'object', properties: { city: { type: 'string' } } } },
        },
      }],
    }
  }
  if (scenario.includes('prompt-caching')) {
    delete body.toolConfig
    body.messages = [{
      role: 'user',
      content: [{ text: scenario === 'converse-prompt-caching' ? 'What is a service' : 'What is a ml app' }],
    }]
    body.inferenceConfig = { temperature: 0.7, topP: 0.9, maxTokens: 1000, stopSequences: [] }
    // eslint-disable-next-line @stylistic/max-len, @stylistic/quotes
    body.system = [{ text: "Software architecture guidelines: bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye bye " }, { cachePoint: { type: 'default' } }]
    return body
  }
  return body
}

async function run (scenario) {
  const tracer = loadTracer('aws-sdk')
  const sdk = require(sdkPackage).get()
  const { NodeHttpHandler } = require(
    path.join(ROOT, 'versions/@aws-sdk/client-bedrock-runtime'),
  ).get('@smithy/node-http-handler')
  const {
    BedrockRuntimeClient,
    InvokeModelCommand,
    ConverseCommand,
  } = sdk
  const client = new BedrockRuntimeClient({
    endpoint: process.env.PROVIDER_BASE_URL,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    requestHandler: new NodeHttpHandler(),
    maxAttempts: 1,
  })
  const modelId = models[scenario]
  try {
    if (scenario.startsWith('embed-')) {
      const body = scenario === 'embed-cohere'
        ? { texts: ['Hello World!', 'Goodbye cruel world!'], input_type: 'search_document' }
        : { inputText: 'Hello World!' }
      await client.send(new InvokeModelCommand({
        modelId,
        body: Buffer.from(JSON.stringify(body)),
        contentType: 'application/json',
        accept: 'application/json',
      }))
    } else if (scenario.startsWith('converse')) {
      await client.send(new ConverseCommand({ modelId, ...converseBody(scenario) }))
    } else {
      await client.send(new InvokeModelCommand({
        modelId,
        body: Buffer.from(JSON.stringify(invokeBody(scenario))),
        contentType: 'application/json',
        accept: 'application/json',
      }))
    }
  } catch (error) {
    void error
  } finally {
    await finish(tracer)
  }
}

module.exports = { run }
