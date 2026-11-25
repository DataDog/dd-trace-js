'use strict'

const path = require('node:path')

const { loadTracer } = require('../common')

const ROOT = path.resolve(__dirname, '../../../../../../..')

/**
 * Both SDKs enable the provider integrations by default, demoting the LangChain model span to a `workflow`
 * around the provider `llm` span. `providers: false` mirrors a user that only enabled LangChain.
 * @param {{ providers?: boolean }} [options]
 */
function loadLangChainTracer ({ providers = true } = {}) {
  const tracer = loadTracer('langchain')
  tracer.use('langgraph', { llmobs: true })
  if (!providers) {
    tracer.use('openai', { enabled: false })
    tracer.use('anthropic', { enabled: false })
  }
  return tracer
}

function langchainModule (subpath) {
  return require(path.join(ROOT, 'versions/langchain@1')).get(subpath)
}

// `@langchain/openai` is resolved from the `@langchain/classic@1` fixture, which pins the 1.x line that shares the
// hoisted `@langchain/core` copy used by `langchain`, `@langchain/langgraph` and `@langchain/anthropic`.
function openAIModule () {
  const classic = require(path.join(ROOT, 'versions/@langchain/classic@1'))
  const classicRoot = path.dirname(classic.getPath('@langchain/classic'))
  return require(require.resolve('@langchain/openai', { paths: [classicRoot] }))
}

// Resolved through the hoisted `langchain@1` fixture so every scenario shares one `@langchain/core` copy.
function coreModule (subpath) {
  return langchainModule(subpath)
}

function classicModule (subpath) {
  return require(path.join(ROOT, 'versions/@langchain/classic@1')).get(subpath)
}

function anthropicModule () {
  return require(path.join(ROOT, 'versions/@langchain/anthropic@1')).get()
}

function langgraphModule (subpath) {
  return require(path.join(ROOT, 'versions/@langchain/langgraph@1')).get(subpath)
}

function zod () {
  return langchainModule('zod')
}

function chatOpenAI (options = {}) {
  const { ChatOpenAI } = openAIModule()
  return new ChatOpenAI({
    model: 'gpt-4o-mini',
    apiKey: process.env.OPENAI_API_KEY,
    configuration: { baseURL: `${process.env.PROVIDER_BASE_URL}/v1` },
    ...options,
  })
}

function openAIEmbeddings (options = {}) {
  const { OpenAIEmbeddings } = openAIModule()
  return new OpenAIEmbeddings({
    model: 'text-embedding-3-small',
    // the Node OpenAI SDK defaults to base64 on the wire; the stub fixtures carry float arrays like Python
    encodingFormat: 'float',
    apiKey: process.env.OPENAI_API_KEY,
    configuration: { baseURL: `${process.env.PROVIDER_BASE_URL}/v1` },
    ...options,
  })
}

function chatAnthropic (options = {}) {
  const { ChatAnthropic } = anthropicModule()
  return new ChatAnthropic({
    model: 'claude-3-5-sonnet-20241022',
    apiKey: process.env.ANTHROPIC_API_KEY,
    clientOptions: { baseURL: process.env.PROVIDER_BASE_URL },
    ...options,
  })
}

module.exports = {
  anthropicModule,
  chatAnthropic,
  chatOpenAI,
  classicModule,
  coreModule,
  langchainModule,
  langgraphModule,
  loadLangChainTracer,
  openAIEmbeddings,
  zod,
}
