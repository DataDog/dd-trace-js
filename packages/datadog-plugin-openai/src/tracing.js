'use strict'

const path = require('path')

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { storage } = require('../../datadog-core')
const services = require('./services')
const Sampler = require('../../dd-trace/src/sampler')
const { MEASURED } = require('../../../ext/tags')

const {
  convertBuffersToObjects,
  constructCompletionResponseFromStreamedChunks,
  constructChatCompletionResponseFromStreamedChunks
} = require('./stream-helpers')

const { DD_MAJOR } = require('../../../version')

class OpenAiTracingPlugin extends TracingPlugin {
  static get id () { return 'openai' }
  static get operation () { return 'request' }
  static get system () { return 'openai' }
  static get prefix () {
    return 'tracing:apm:openai:request'
  }

  constructor (...args) {
    super(...args)

    const { metrics, logger } = services.init(this._tracerConfig)
    this.metrics = metrics
    this.logger = logger

    this.sampler = new Sampler(0.1) // default 10% log sampling

    this.addSub('apm:openai:request:chunk', ({ ctx, chunk, done }) => {
      if (!ctx.chunks) ctx.chunks = []

      if (chunk) ctx.chunks.push(chunk)
      if (!done) return

      let chunks = ctx.chunks
      if (chunks.length === 0) return

      const firstChunk = chunks[0]
      // OpenAI in legacy versions returns chunked buffers instead of objects.
      // These buffers will need to be combined and coalesced into a list of object chunks.
      if (firstChunk instanceof Buffer) {
        chunks = convertBuffersToObjects(chunks)
      }

      const methodName = ctx.currentStore.normalizedMethodName
      let n = 1
      const prompt = ctx.args[0].prompt
      if (Array.isArray(prompt) && typeof prompt[0] !== 'number') {
        n *= prompt.length
      }

      let response = {}
      if (methodName === 'createCompletion') {
        response = constructCompletionResponseFromStreamedChunks(chunks, n)
      } else if (methodName === 'createChatCompletion') {
        response = constructChatCompletionResponseFromStreamedChunks(chunks, n)
      }

      ctx.result = { data: response }
    })
  }

  configure (config) {
    if (config.enabled === false) {
      services.shutdown()
    }

    super.configure(config)
  }

  bindStart (ctx) {
    const { methodName, args } = ctx
    const payload = normalizeRequestPayload(methodName, args)
    const normalizedMethodName = normalizeMethodName(methodName)

    const store = storage('legacy').getStore() || {}

    // hold onto these to make response extraction matching efficient
    // the original method name corresponds to the SDK method name (e.g. createChatCompletion, chat.completions.create)
    // the normalized method name corresponds to the resource name (e.g. createChatCompletion, createCompletion)
    store.originalMethodName = methodName
    store.normalizedMethodName = normalizedMethodName

    const span = this.startSpan('openai.request', {
      service: this.config.service,
      resource: DD_MAJOR >= 6 ? normalizedMethodName : methodName,
      type: 'openai',
      kind: 'client',
      meta: {
        [MEASURED]: 1,
        // Only model is added to all requests
        'openai.request.model': payload.model
      }
    }, false)

    const openaiStore = Object.create(null)

    const tags = {} // The remaining tags are added one at a time

    if (payload.stream) {
      tags['openai.request.stream'] = payload.stream
    }

    switch (normalizedMethodName) {
      case 'createImage':
      case 'createImageEdit':
      case 'createImageVariation':
        commonCreateImageRequestExtraction(tags, payload, openaiStore)
        break

      case 'createChatCompletion':
        createChatCompletionRequestExtraction(tags, payload, openaiStore)
        break

      case 'createFile':
      case 'retrieveFile':
        commonFileRequestExtraction(tags, payload)
        break

      case 'createTranscription':
      case 'createTranslation':
        commonCreateAudioRequestExtraction(tags, payload, openaiStore)
        break

      case 'retrieveModel':
        retrieveModelRequestExtraction(tags, payload)
        break

      case 'createEdit':
        createEditRequestExtraction(tags, payload, openaiStore)
        break

      case 'createResponse':
        createResponseRequestExtraction(tags, payload, openaiStore)
        break
    }

    span.addTags(tags)

    ctx.currentStore = { ...store, span, openai: openaiStore }

    return ctx.currentStore
  }

  asyncEnd (ctx) {
    const { result } = ctx
    const store = ctx.currentStore

    const span = store?.span
    if (!span) return

    const error = !!span.context()._tags.error

    let headers, body, method, path
    if (!error) {
      headers = result.headers
      body = result.data
      method = result.request.method
      path = result.request.path
    }

    if (!error && headers?.constructor.name === 'Headers') {
      headers = Object.fromEntries(headers)
    }

    const resource = span._spanContext._tags['resource.name']
    const normalizedMethodName = store.normalizedMethodName

    body = coerceResponseBody(body, normalizedMethodName)

    const openaiStore = store.openai

    if (!error && (path?.startsWith('https://') || path?.startsWith('http://'))) {
      // basic checking for if the path was set as a full URL
      // not using a full regex as it will likely be "https://api.openai.com/..."
      path = new URL(path).pathname
    }

    const originalMethodName = store.originalMethodName
    const endpoint = lookupOperationEndpoint(normalizedMethodName, originalMethodName, path)

    const tags = error
      ? {}
      : {
          'openai.request.endpoint': endpoint,
          'openai.request.method': method.toUpperCase(),

          'openai.response.model': headers['openai-model'] || body.model, // specific model, often undefined
          'openai.response.id': body.id, // common creation value, numeric epoch
          'openai.response.deleted': body.deleted, // common boolean field in delete responses

          // The OpenAI API appears to use both created and created_at in different places
          // Here we're conciously choosing to surface this inconsistency instead of normalizing
          'openai.response.created': body.created,
          'openai.response.created_at': body.created_at
        }

    responseDataExtractionByMethod(normalizedMethodName, tags, body, openaiStore)
    span.addTags(tags)

    span.finish()
    this.sendLog(resource, span, tags, openaiStore, error)
    this.sendMetrics(headers, body, endpoint, span._duration, error, tags)
  }

  sendMetrics (headers, body, endpoint, duration, error, spanTags) {
    const tags = [`error:${Number(!!error)}`]
    if (error) {
      this.metrics.increment('openai.request.error', 1, tags)
    } else {
      tags.push(
        `org:${headers['openai-organization']}`,
        `endpoint:${endpoint}`,
        `model:${headers['openai-model'] || body.model}`
      )
    }

    this.metrics.distribution('openai.request.duration', duration * 1000, tags)

    const promptTokens = spanTags['openai.response.usage.prompt_tokens']
    const promptTokensEstimated = spanTags['openai.response.usage.prompt_tokens_estimated']

    const completionTokens = spanTags['openai.response.usage.completion_tokens']
    const completionTokensEstimated = spanTags['openai.response.usage.completion_tokens_estimated']

    const totalTokens = spanTags['openai.response.usage.total_tokens']

    if (!error) {
      if (promptTokens != null) {
        if (promptTokensEstimated) {
          this.metrics.distribution(
            'openai.tokens.prompt', promptTokens, [...tags, 'openai.estimated:true'])
        } else {
          this.metrics.distribution('openai.tokens.prompt', promptTokens, tags)
        }
      }

      if (completionTokens != null) {
        if (completionTokensEstimated) {
          this.metrics.distribution(
            'openai.tokens.completion', completionTokens, [...tags, 'openai.estimated:true'])
        } else {
          this.metrics.distribution('openai.tokens.completion', completionTokens, tags)
        }
      }

      if (totalTokens != null) {
        if (promptTokensEstimated || completionTokensEstimated) {
          this.metrics.distribution(
            'openai.tokens.total', totalTokens, [...tags, 'openai.estimated:true'])
        } else {
          this.metrics.distribution('openai.tokens.total', totalTokens, tags)
        }
      }
    }

    if (headers) {
      if (headers['x-ratelimit-limit-requests']) {
        this.metrics.gauge('openai.ratelimit.requests', Number(headers['x-ratelimit-limit-requests']), tags)
      }

      if (headers['x-ratelimit-remaining-requests']) {
        this.metrics.gauge(
          'openai.ratelimit.remaining.requests', Number(headers['x-ratelimit-remaining-requests']), tags
        )
      }

      if (headers['x-ratelimit-limit-tokens']) {
        this.metrics.gauge('openai.ratelimit.tokens', Number(headers['x-ratelimit-limit-tokens']), tags)
      }

      if (headers['x-ratelimit-remaining-tokens']) {
        this.metrics.gauge('openai.ratelimit.remaining.tokens', Number(headers['x-ratelimit-remaining-tokens']), tags)
      }
    }
  }

  sendLog (methodName, span, tags, openaiStore, error) {
    if (!openaiStore) return
    if (!Object.keys(openaiStore).length) return
    if (!this.sampler.isSampled(span)) return

    const log = {
      status: error ? 'error' : 'info',
      message: `sampled ${methodName}`,
      ...openaiStore
    }

    this.logger.log(log, span, tags)
  }
}

function normalizeMethodName (methodName) {
  switch (methodName) {
    // moderations
    case 'moderations.create':
      return 'createModeration'

    // completions
    case 'completions.create':
      return 'createCompletion'

    // chat completions
    case 'chat.completions.create':
      return 'createChatCompletion'

    // edits
    case 'edits.create':
      return 'createEdit'

    // embeddings
    case 'embeddings.create':
      return 'createEmbedding'

    // responses
    case 'responses.create':
      return 'createResponse'

    // files
    case 'files.create':
      return 'createFile'
    case 'files.retrieve':
      return 'retrieveFile'
    case 'files.del':
    case 'files.delete':
      return 'deleteFile'
    case 'files.retrieveContent':
    case 'files.content':
      return 'downloadFile'
    case 'files.list':
      return 'listFiles'

    // fine-tuning
    case 'fine_tuning.jobs.list':
    case 'fine-tune.list':
      return 'listFineTunes'
    case 'fine_tuning.jobs.listEvents':
    case 'fine-tune.listEvents':
      return 'listFineTuneEvents'
    case 'fine_tuning.jobs.create':
    case 'fine-tune.create':
      return 'createFineTune'
    case 'fine_tuning.jobs.retrieve':
    case 'fine-tune.retrieve':
      return 'retrieveFineTune'
    case 'fine_tuning.jobs.cancel':
    case 'fine-tune.cancel':
      return 'cancelFineTune'

    // audio
    case 'audio.transcriptions.create':
      return 'createTranscription'
    case 'audio.translations.create':
      return 'createTranslation'

    // images
    case 'images.generate':
      return 'createImage'
    case 'images.edit':
      return 'createImageEdit'
    case 'images.createVariation':
      return 'createImageVariation'

    // models
    case 'models.list':
      return 'listModels'
    case 'models.retrieve':
      return 'retrieveModel'
    case 'models.del':
    case 'models.delete':
      return 'deleteModel'
    default:
      return methodName
  }
}

function createEditRequestExtraction (tags, payload, openaiStore) {
  const instruction = payload.instruction
  openaiStore.instruction = instruction
}

function createResponseRequestExtraction (tags, payload, openaiStore) {
  // Extract model information
  if (payload.model) {
    tags['openai.request.model'] = payload.model
  }
  
  // Extract input information
  if (payload.input) {
    openaiStore.input = payload.input
    tags['openai.request.input_length'] = payload.input.length
  }
  
  // Extract reasoning configuration
  if (payload.reasoning) {
    if (payload.reasoning.effort) {
      tags['openai.request.reasoning.effort'] = payload.reasoning.effort
    }
    openaiStore.reasoning = payload.reasoning
  }
  
  // Extract background flag
  if (payload.background !== undefined) {
    tags['openai.request.background'] = payload.background
  }
  
  // Store the full payload for response extraction
  openaiStore.responseData = payload
}

function retrieveModelRequestExtraction (tags, payload) {
  tags['openai.request.id'] = payload.id
}

function createChatCompletionRequestExtraction (tags, payload, openaiStore) {
  const messages = payload.messages
  if (!defensiveArrayLength(messages)) return

  openaiStore.messages = payload.messages
}

function commonCreateImageRequestExtraction (tags, payload, openaiStore) {
  // createImageEdit, createImageVariation
  const img = payload.file || payload.image
  if (img !== null && typeof img === 'object' && img.path) {
    const file = path.basename(img.path)
    openaiStore.file = file
  }

  // createImageEdit
  if (payload.mask !== null && typeof payload.mask === 'object' && payload.mask.path) {
    const mask = path.basename(payload.mask.path)
    openaiStore.mask = mask
  }
}

function responseDataExtractionByMethod (methodName, tags, body, openaiStore) {
  switch (methodName) {
    case 'createCompletion':
    case 'createChatCompletion':
    case 'createEdit':
      commonCreateResponseExtraction(tags, body, openaiStore, methodName)
      break

    case 'createResponse':
      createResponseResponseExtraction(tags, body, openaiStore)
      break

    case 'listFiles':
    case 'listFineTunes':
    case 'listFineTuneEvents':
      commonListCountResponseExtraction(tags, body)
      break

    case 'createFile':
    case 'retrieveFile':
      createRetrieveFileResponseExtraction(tags, body)
      break

    case 'deleteFile':
      deleteFileResponseExtraction(tags, body)
      break

    case 'downloadFile':
      downloadFileResponseExtraction(tags, body)
      break

    case 'listModels':
      listModelsResponseExtraction(tags, body)
      break

    case 'retrieveModel':
      retrieveModelResponseExtraction(tags, body)
      break
  }
}

function retrieveModelResponseExtraction (tags, body) {
  tags['openai.response.owned_by'] = body.owned_by
  tags['openai.response.parent'] = body.parent
  tags['openai.response.root'] = body.root

  if (!body.permission) return

  tags['openai.response.permission.id'] = body.permission[0].id
  tags['openai.response.permission.created'] = body.permission[0].created
  tags['openai.response.permission.allow_create_engine'] = body.permission[0].allow_create_engine
  tags['openai.response.permission.allow_sampling'] = body.permission[0].allow_sampling
  tags['openai.response.permission.allow_logprobs'] = body.permission[0].allow_logprobs
  tags['openai.response.permission.allow_search_indices'] = body.permission[0].allow_search_indices
  tags['openai.response.permission.allow_view'] = body.permission[0].allow_view
  tags['openai.response.permission.allow_fine_tuning'] = body.permission[0].allow_fine_tuning
  tags['openai.response.permission.organization'] = body.permission[0].organization
  tags['openai.response.permission.group'] = body.permission[0].group
  tags['openai.response.permission.is_blocking'] = body.permission[0].is_blocking
}

function listModelsResponseExtraction (tags, body) {
  if (!body.data) return

  tags['openai.response.count'] = body.data.length
}

// the OpenAI package appears to stream the content download then provide it all as a singular string
function downloadFileResponseExtraction (tags, body) {
  if (typeof body.file !== 'string') return
  tags['openai.response.total_bytes'] = Buffer.byteLength(body.file)
}

function deleteFileResponseExtraction (tags, body) {
  tags['openai.response.id'] = body.id
}

function commonCreateAudioRequestExtraction (tags, body, openaiStore) {
  if (body.file !== null && typeof body.file === 'object' && body.file.path) {
    const filename = path.basename(body.file.path)
    openaiStore.file = filename
  }
}

function commonFileRequestExtraction (tags, body) {
  tags['openai.request.purpose'] = body.purpose

  // User can provider either exact file contents or a file read stream
  // With the stream we extract the filepath
  // This is a best effort attempt to extract the filename during the request
  if (body.file !== null && typeof body.file === 'object' && body.file.path) {
    tags['openai.request.filename'] = path.basename(body.file.path)
  }
}

function createRetrieveFileResponseExtraction (tags, body) {
  tags['openai.response.filename'] = body.filename
  tags['openai.response.purpose'] = body.purpose
  tags['openai.response.bytes'] = body.bytes
  tags['openai.response.status'] = body.status
  tags['openai.response.status_details'] = body.status_details
}

function commonListCountResponseExtraction (tags, body) {
  if (!body.data) return
  tags['openai.response.count'] = body.data.length
}

// createCompletion, createChatCompletion, createEdit
function commonCreateResponseExtraction (tags, body, openaiStore, methodName) {
  if (!body.choices) return

  openaiStore.choices = body.choices
}

function createResponseResponseExtraction (tags, body, openaiStore) {
  // Extract response ID if available
  if (body.id) {
    tags['openai.response.id'] = body.id
  }
  
  // Extract status if available
  if (body.status) {
    tags['openai.response.status'] = body.status
  }
  
  // Extract model from response if available
  if (body.model) {
    tags['openai.response.model'] = body.model
  }
  
  // Store the full response for potential future use
  openaiStore.response = body
}

// The server almost always responds with JSON
function coerceResponseBody (body, methodName) {
  switch (methodName) {
    case 'downloadFile':
      return { file: body }
  }

  const type = typeof body
  if (type === 'string') {
    try {
      return JSON.parse(body)
    } catch {
      return body
    }
  } else if (type === 'object') {
    return body
  } else {
    return {}
  }
}

// This method is used to replace a dynamic URL segment with an asterisk
function lookupOperationEndpoint (operationId, methodName, url) {
  switch (operationId) {
    case 'deleteModel':
    case 'retrieveModel':
      return '/v1/models/*'

    case 'deleteFile':
    case 'retrieveFile':
      return '/v1/files/*'

    case 'downloadFile':
      return '/v1/files/*/content'

    case 'retrieveFineTune':
      switch (methodName) {
        case 'fine_tuning.jobs.retrieve':
          return '/v1/fine_tuning/jobs/*'
        default:
          return '/v1/fine-tunes/*'
      }

    case 'listFineTuneEvents':
      switch (methodName) {
        case 'fine_tuning.jobs.listEvents':
          return '/v1/fine_tuning/jobs/*/events'
        default:
          return '/v1/fine-tunes/*/events'
      }

    case 'cancelFineTune':
      switch (methodName) {
        case 'fine_tuning.jobs.cancel':
          return '/v1/fine_tuning/jobs/*/cancel'
        default:
          return '/v1/fine-tunes/*/cancel'
      }
  }

  return url
}

/**
 * This function essentially normalizes the OpenAI method interface. Many methods accept
 * a single object argument. The remaining ones take individual arguments. This function
 * turns the individual arguments into an object to make extracting properties consistent.
 */
function normalizeRequestPayload (methodName, args) {
  switch (methodName) {
    case 'listModels':
    case 'models.list':
    case 'listFiles':
    case 'files.list':
    case 'listFineTunes':
    case 'fine_tuning.jobs.list':
    case 'fine-tune.list':
      // no argument
      return {}

    case 'retrieveModel':
    case 'models.retrieve':
      return { id: args[0] }

    case 'createFile':
      return {
        file: args[0],
        purpose: args[1]
      }

    case 'deleteFile':
    case 'files.del':
    case 'files.delete':
    case 'retrieveFile':
    case 'files.retrieve':
    case 'downloadFile':
    case 'files.retrieveContent':
    case 'files.content':
      return { file_id: args[0] }

    case 'listFineTuneEvents':
    case 'fine_tuning.jobs.listEvents':
    case 'fine-tune.listEvents':
      return {
        fine_tune_id: args[0],
        stream: args[1] // undocumented
      }

    case 'retrieveFineTune':
    case 'fine_tuning.jobs.retrieve':
    case 'fine-tune.retrieve':
    case 'deleteModel':
    case 'models.del':
    case 'models.delete':
    case 'cancelFineTune':
    case 'fine_tuning.jobs.cancel':
    case 'fine-tune.cancel':
      return { fine_tune_id: args[0] }

    case 'createImageEdit':
      return {
        file: args[0],
        prompt: args[1], // Note: order of prompt/mask in Node.js lib differs from public docs
        mask: args[2],
        n: args[3],
        size: args[4],
        response_format: args[5],
        user: args[6]
      }

    case 'createImageVariation':
      return {
        file: args[0],
        n: args[1],
        size: args[2],
        response_format: args[3],
        user: args[4]
      }

    case 'createTranscription':
    case 'createTranslation':
      return {
        file: args[0],
        model: args[1],
        prompt: args[2],
        response_format: args[3],
        temperature: args[4],
        language: args[5] // only used for createTranscription
      }
  }

  // Remaining OpenAI methods take a single object argument
  return args[0]
}

function defensiveArrayLength (maybeArray) {
  if (maybeArray) {
    // Detect singular item (ie body.training_file vs body.training_files)
    return Array.isArray(maybeArray) ? maybeArray.length : 1
  }
}

module.exports = OpenAiTracingPlugin
