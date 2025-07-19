'use strict'

const path = require('path')

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { storage } = require('../../datadog-core')
const services = require('./services')
const Sampler = require('../../dd-trace/src/sampler')
const { MEASURED } = require('../../../ext/tags')
const { estimateTokens } = require('./token-estimator')

const makeUtilities = require('../../dd-trace/src/plugins/util/llm')
const {
  convertBuffersToObjects,
  constructCompletionResponseFromStreamedChunks,
  constructChatCompletionResponseFromStreamedChunks
} = require('./stream-helpers')

let normalize

const { DD_MAJOR } = require('../../../version')

function safeRequire (path) {
  try {
    return require(path)
  } catch {
    return null
  }
}

const encodingForModel = safeRequire('tiktoken')?.encoding_for_model

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

    // hoist the normalize function to avoid making all of these functions a class method
    if (this._tracerConfig) {
      const utilities = makeUtilities('openai', this._tracerConfig)

      normalize = utilities.normalize
    }

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
    const { methodName, args, basePath, apiKey } = ctx
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
        // Data that is always available with a request
        'openai.user.api_key': truncateApiKey(apiKey),
        'openai.api_base': basePath,
        // The openai.api_type (openai|azure) is present in Python but not in Node.js
        // Add support once https://github.com/openai/openai-node/issues/53 is closed

        // Data that is common across many requests
        'openai.request.best_of': payload.best_of,
        'openai.request.echo': payload.echo,
        'openai.request.logprobs': payload.logprobs,
        'openai.request.max_tokens': payload.max_tokens,
        'openai.request.model': payload.model, // vague model
        'openai.request.n': payload.n,
        'openai.request.presence_penalty': payload.presence_penalty,
        'openai.request.frequency_penalty': payload.frequency_penalty,
        'openai.request.stop': payload.stop,
        'openai.request.suffix': payload.suffix,
        'openai.request.temperature': payload.temperature,
        'openai.request.top_p': payload.top_p,
        'openai.request.user': payload.user,
        'openai.request.file_id': payload.file_id // deleteFile, retrieveFile, downloadFile
      }
    }, false)

    const openaiStore = Object.create(null)

    const tags = {} // The remaining tags are added one at a time

    // createChatCompletion, createCompletion, createImage, createImageEdit, createTranscription, createTranslation
    if (payload.prompt) {
      const prompt = payload.prompt
      openaiStore.prompt = prompt
      if (typeof prompt === 'string' || (Array.isArray(prompt) && typeof prompt[0] === 'number')) {
        // This is a single prompt, either String or [Number]
        tags['openai.request.prompt'] = normalizeStringOrTokenArray(prompt, true)
      } else if (Array.isArray(prompt)) {
        // This is multiple prompts, either [String] or [[Number]]
        for (let i = 0; i < prompt.length; i++) {
          tags[`openai.request.prompt.${i}`] = normalizeStringOrTokenArray(prompt[i], true)
        }
      }
    }

    // createEdit, createEmbedding, createModeration
    if (payload.input) {
      const normalized = normalizeStringOrTokenArray(payload.input, false)
      tags['openai.request.input'] = normalize(normalized)
      openaiStore.input = normalized
    }

    // createChatCompletion, createCompletion
    if (payload.logit_bias !== null && typeof payload.logit_bias === 'object') {
      for (const [tokenId, bias] of Object.entries(payload.logit_bias)) {
        tags[`openai.request.logit_bias.${tokenId}`] = bias
      }
    }

    if (payload.stream) {
      tags['openai.request.stream'] = payload.stream
    }

    switch (normalizedMethodName) {
      case 'createFineTune':
        createFineTuneRequestExtraction(tags, payload)
        break

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

      case 'listFineTuneEvents':
      case 'retrieveFineTune':
      case 'deleteModel':
      case 'cancelFineTune':
        commonLookupFineTuneRequestExtraction(tags, payload)
        break

      case 'createEdit':
        createEditRequestExtraction(tags, payload, openaiStore)
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

          'openai.organization.id': body.organization_id, // only available in fine-tunes endpoints
          'openai.organization.name': headers['openai-organization'],

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

function countPromptTokens (methodName, payload, model) {
  let promptTokens = 0
  let promptEstimated = false
  if (methodName === 'createChatCompletion') {
    const messages = payload.messages
    for (const message of messages) {
      const content = message.content
      if (typeof content === 'string') {
        const { tokens, estimated } = countTokens(content, model)
        promptTokens += tokens
        promptEstimated = estimated
      } else if (Array.isArray(content)) {
        for (const c of content) {
          if (c.type === 'text') {
            const { tokens, estimated } = countTokens(c.text, model)
            promptTokens += tokens
            promptEstimated = estimated
          }
          // unsupported token computation for image_url
          // as even though URL is a string, its true token count
          // is based on the image itself, something onerous to do client-side
        }
      }
    }
  } else if (methodName === 'createCompletion') {
    let prompt = payload.prompt
    if (!Array.isArray(prompt)) prompt = [prompt]

    for (const p of prompt) {
      const { tokens, estimated } = countTokens(p, model)
      promptTokens += tokens
      promptEstimated = estimated
    }
  }

  return { promptTokens, promptEstimated }
}

function countCompletionTokens (body, model) {
  let completionTokens = 0
  let completionEstimated = false
  if (body?.choices) {
    for (const choice of body.choices) {
      const message = choice.message || choice.delta // delta for streamed responses
      const text = choice.text
      const content = text || message?.content

      const { tokens, estimated } = countTokens(content, model)
      completionTokens += tokens
      completionEstimated = estimated
    }
  }

  return { completionTokens, completionEstimated }
}

function countTokens (content, model) {
  if (encodingForModel) {
    try {
      // try using tiktoken if it was available
      const encoder = encodingForModel(model)
      const tokens = encoder.encode(content).length
      encoder.free()
      return { tokens, estimated: false }
    } catch {
      // possible errors from tiktoken:
      // * model not available for token counts
      // * issue encoding content
    }
  }

  return {
    tokens: estimateTokens(content),
    estimated: true
  }
}

function createEditRequestExtraction (tags, payload, openaiStore) {
  const instruction = payload.instruction
  tags['openai.request.instruction'] = instruction
  openaiStore.instruction = instruction
}

function retrieveModelRequestExtraction (tags, payload) {
  tags['openai.request.id'] = payload.id
}

function createChatCompletionRequestExtraction (tags, payload, openaiStore) {
  const messages = payload.messages
  if (!defensiveArrayLength(messages)) return

  openaiStore.messages = payload.messages
  for (let i = 0; i < payload.messages.length; i++) {
    const message = payload.messages[i]
    tagChatCompletionRequestContent(message.content, i, tags)
    tags[`openai.request.messages.${i}.role`] = message.role
    tags[`openai.request.messages.${i}.name`] = message.name
    tags[`openai.request.messages.${i}.finish_reason`] = message.finish_reason
  }
}

function commonCreateImageRequestExtraction (tags, payload, openaiStore) {
  // createImageEdit, createImageVariation
  const img = payload.file || payload.image
  if (img !== null && typeof img === 'object' && img.path) {
    const file = path.basename(img.path)
    tags['openai.request.image'] = file
    openaiStore.file = file
  }

  // createImageEdit
  if (payload.mask !== null && typeof payload.mask === 'object' && payload.mask.path) {
    const mask = path.basename(payload.mask.path)
    tags['openai.request.mask'] = mask
    openaiStore.mask = mask
  }

  tags['openai.request.size'] = payload.size
  tags['openai.request.response_format'] = payload.response_format
  tags['openai.request.language'] = payload.language
}

function responseDataExtractionByMethod (methodName, tags, body, openaiStore) {
  switch (methodName) {
    case 'createModeration':
      createModerationResponseExtraction(tags, body)
      break

    case 'createCompletion':
    case 'createChatCompletion':
    case 'createEdit':
      commonCreateResponseExtraction(tags, body, openaiStore, methodName)
      break

    case 'listFiles':
    case 'listFineTunes':
    case 'listFineTuneEvents':
      commonListCountResponseExtraction(tags, body)
      break

    case 'createEmbedding':
      createEmbeddingResponseExtraction(tags, body, openaiStore)
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

    case 'createFineTune':
    case 'retrieveFineTune':
    case 'cancelFineTune':
      commonFineTuneResponseExtraction(tags, body)
      break

    case 'createTranscription':
    case 'createTranslation':
      createAudioResponseExtraction(tags, body)
      break

    case 'createImage':
    case 'createImageEdit':
    case 'createImageVariation':
      commonImageResponseExtraction(tags, body)
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

function commonLookupFineTuneRequestExtraction (tags, body) {
  tags['openai.request.fine_tune_id'] = body.fine_tune_id
  tags['openai.request.stream'] = !!body.stream // listFineTuneEvents
}

function listModelsResponseExtraction (tags, body) {
  if (!body.data) return

  tags['openai.response.count'] = body.data.length
}

function commonImageResponseExtraction (tags, body) {
  if (!body.data) return

  tags['openai.response.images_count'] = body.data.length

  for (let i = 0; i < body.data.length; i++) {
    const image = body.data[i]
    // exactly one of these two options is provided
    tags[`openai.response.images.${i}.url`] = normalize(image.url)
    tags[`openai.response.images.${i}.b64_json`] = image.b64_json && 'returned'
  }
}

function createAudioResponseExtraction (tags, body) {
  tags['openai.response.text'] = body.text
  tags['openai.response.language'] = body.language
  tags['openai.response.duration'] = body.duration
  tags['openai.response.segments_count'] = defensiveArrayLength(body.segments)
}

function createFineTuneRequestExtraction (tags, body) {
  tags['openai.request.training_file'] = body.training_file
  tags['openai.request.validation_file'] = body.validation_file
  tags['openai.request.n_epochs'] = body.n_epochs
  tags['openai.request.batch_size'] = body.batch_size
  tags['openai.request.learning_rate_multiplier'] = body.learning_rate_multiplier
  tags['openai.request.prompt_loss_weight'] = body.prompt_loss_weight
  tags['openai.request.compute_classification_metrics'] = body.compute_classification_metrics
  tags['openai.request.classification_n_classes'] = body.classification_n_classes
  tags['openai.request.classification_positive_class'] = body.classification_positive_class
  tags['openai.request.classification_betas_count'] = defensiveArrayLength(body.classification_betas)
}

function commonFineTuneResponseExtraction (tags, body) {
  tags['openai.response.events_count'] = defensiveArrayLength(body.events)
  tags['openai.response.fine_tuned_model'] = body.fine_tuned_model

  const hyperparams = body.hyperparams || body.hyperparameters
  const hyperparamsKey = body.hyperparams ? 'hyperparams' : 'hyperparameters'

  if (hyperparams) {
    tags[`openai.response.${hyperparamsKey}.n_epochs`] = hyperparams.n_epochs
    tags[`openai.response.${hyperparamsKey}.batch_size`] = hyperparams.batch_size
    tags[`openai.response.${hyperparamsKey}.prompt_loss_weight`] = hyperparams.prompt_loss_weight
    tags[`openai.response.${hyperparamsKey}.learning_rate_multiplier`] = hyperparams.learning_rate_multiplier
  }
  tags['openai.response.training_files_count'] = defensiveArrayLength(body.training_files || body.training_file)
  tags['openai.response.result_files_count'] = defensiveArrayLength(body.result_files)
  tags['openai.response.validation_files_count'] = defensiveArrayLength(body.validation_files || body.validation_file)
  tags['openai.response.updated_at'] = body.updated_at
  tags['openai.response.status'] = body.status
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
  tags['openai.request.response_format'] = body.response_format
  tags['openai.request.language'] = body.language

  if (body.file !== null && typeof body.file === 'object' && body.file.path) {
    const filename = path.basename(body.file.path)
    tags['openai.request.filename'] = filename
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

function createEmbeddingResponseExtraction (tags, body, openaiStore) {
  usageExtraction(tags, body, openaiStore)

  if (!body.data) return

  tags['openai.response.embeddings_count'] = body.data.length
  for (let i = 0; i < body.data.length; i++) {
    tags[`openai.response.embedding.${i}.embedding_length`] = body.data[i].embedding.length
  }
}

function commonListCountResponseExtraction (tags, body) {
  if (!body.data) return
  tags['openai.response.count'] = body.data.length
}

// TODO: Is there ever more than one entry in body.results?
function createModerationResponseExtraction (tags, body) {
  tags['openai.response.id'] = body.id
  // tags[`openai.response.model`] = body.model // redundant, already extracted globally

  if (!body.results) return

  tags['openai.response.flagged'] = body.results[0].flagged

  for (const [category, match] of Object.entries(body.results[0].categories)) {
    tags[`openai.response.categories.${category}`] = match
  }

  for (const [category, score] of Object.entries(body.results[0].category_scores)) {
    tags[`openai.response.category_scores.${category}`] = score
  }
}

// createCompletion, createChatCompletion, createEdit
function commonCreateResponseExtraction (tags, body, openaiStore, methodName) {
  usageExtraction(tags, body, methodName, openaiStore)

  if (!body.choices) return

  tags['openai.response.choices_count'] = body.choices.length

  openaiStore.choices = body.choices

  for (let choiceIdx = 0; choiceIdx < body.choices.length; choiceIdx++) {
    const choice = body.choices[choiceIdx]

    // logprobs can be null and we still want to tag it as 'returned' even when set to 'null'
    const specifiesLogProb = Object.keys(choice).includes('logprobs')

    tags[`openai.response.choices.${choiceIdx}.finish_reason`] = choice.finish_reason
    tags[`openai.response.choices.${choiceIdx}.logprobs`] = specifiesLogProb ? 'returned' : undefined
    tags[`openai.response.choices.${choiceIdx}.text`] = normalize(choice.text)

    // createChatCompletion only
    const message = choice.message || choice.delta // delta for streamed responses
    if (message) {
      tags[`openai.response.choices.${choiceIdx}.message.role`] = message.role
      tags[`openai.response.choices.${choiceIdx}.message.content`] = normalize(message.content)
      tags[`openai.response.choices.${choiceIdx}.message.name`] = normalize(message.name)
      if (message.tool_calls) {
        const toolCalls = message.tool_calls
        for (let toolIdx = 0; toolIdx < toolCalls.length; toolIdx++) {
          tags[`openai.response.choices.${choiceIdx}.message.tool_calls.${toolIdx}.function.name`] =
            toolCalls[toolIdx].function.name
          tags[`openai.response.choices.${choiceIdx}.message.tool_calls.${toolIdx}.function.arguments`] =
            toolCalls[toolIdx].function.arguments
          tags[`openai.response.choices.${choiceIdx}.message.tool_calls.${toolIdx}.id`] =
            toolCalls[toolIdx].id
        }
      }
    }
  }
}

// createCompletion, createChatCompletion, createEdit, createEmbedding
function usageExtraction (tags, body, methodName, openaiStore) {
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0
  if (body && body.usage) {
    promptTokens = body.usage.prompt_tokens
    completionTokens = body.usage.completion_tokens
    totalTokens = body.usage.total_tokens
  } else if (body.model && ['createChatCompletion', 'createCompletion'].includes(methodName)) {
    // estimate tokens based on method name for completions and chat completions
    const { model } = body

    // prompt tokens
    const payload = openaiStore
    const promptTokensCount = countPromptTokens(methodName, payload, model)
    promptTokens = promptTokensCount.promptTokens
    const promptEstimated = promptTokensCount.promptEstimated

    // completion tokens
    const completionTokensCount = countCompletionTokens(body, model)
    completionTokens = completionTokensCount.completionTokens
    const completionEstimated = completionTokensCount.completionEstimated

    // total tokens
    totalTokens = promptTokens + completionTokens
    if (promptEstimated) tags['openai.response.usage.prompt_tokens_estimated'] = true
    if (completionEstimated) tags['openai.response.usage.completion_tokens_estimated'] = true
  }

  if (promptTokens != null) tags['openai.response.usage.prompt_tokens'] = promptTokens
  if (completionTokens != null) tags['openai.response.usage.completion_tokens'] = completionTokens
  if (totalTokens != null) tags['openai.response.usage.total_tokens'] = totalTokens
}

function truncateApiKey (apiKey) {
  return apiKey && `sk-...${apiKey.slice(-4)}`
}

function tagChatCompletionRequestContent (contents, messageIdx, tags) {
  if (typeof contents === 'string') {
    tags[`openai.request.messages.${messageIdx}.content`] = normalize(contents)
  } else if (Array.isArray(contents)) {
    // content can also be an array of objects
    // which represent text input or image url
    for (const contentIdx in contents) {
      const content = contents[contentIdx]
      const type = content.type
      tags[`openai.request.messages.${messageIdx}.content.${contentIdx}.type`] = content.type
      if (type === 'text') {
        tags[`openai.request.messages.${messageIdx}.content.${contentIdx}.text`] = normalize(content.text)
      } else if (type === 'image_url') {
        tags[`openai.request.messages.${messageIdx}.content.${contentIdx}.image_url.url`] =
          normalize(content.image_url.url)
      }
      // unsupported type otherwise, won't be tagged
    }
  }
  // unsupported type otherwise, won't be tagged
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

/**
 * Converts an array of tokens to a string
 * If input is already a string it's returned
 * In either case the value is truncated

 * It's intentional that the array be truncated arbitrarily, e.g. "[999, 888, 77..."

 * "foo" -> "foo"
 * [1,2,3] -> "[1, 2, 3]"
 */
function normalizeStringOrTokenArray (input, truncate) {
  const normalized = Array.isArray(input)
    ? `[${input.join(', ')}]` // "[1, 2, 999]"
    : input // "foo"
  return truncate ? normalize(normalized) : normalized
}

function defensiveArrayLength (maybeArray) {
  if (maybeArray) {
    // Detect singular item (ie body.training_file vs body.training_files)
    return Array.isArray(maybeArray) ? maybeArray.length : 1
  }
}

module.exports = OpenAiTracingPlugin
