'use strict'

const path = require('path')

const TracingPlugin = require('../../dd-trace/src/plugins/tracing')
const { storage } = require('../../datadog-core')
const services = require('./services')
const Sampler = require('../../dd-trace/src/sampler')
const { MEASURED } = require('../../../ext/tags')

// String#replaceAll unavailable on Node.js@v14 (dd-trace@<=v3)
const RE_NEWLINE = /\n/g
const RE_TAB = /\t/g

// TODO: In the future we should refactor config.js to make it requirable
let MAX_TEXT_LEN = 128

class OpenApiPlugin extends TracingPlugin {
  static get id () { return 'openai' }
  static get operation () { return 'request' }
  static get system () { return 'openai' }

  constructor (...args) {
    super(...args)

    const { metrics, logger } = services.init(this._tracerConfig)
    this.metrics = metrics
    this.logger = logger

    this.sampler = new Sampler(0.1) // default 10% log sampling

    // hoist the max length env var to avoid making all of these functions a class method
    if (this._tracerConfig) {
      MAX_TEXT_LEN = this._tracerConfig.openaiSpanCharLimit
    }
  }

  configure (config) {
    if (config.enabled === false) {
      services.shutdown()
    }

    super.configure(config)
  }

  start ({ methodName, args, basePath, apiKey }) {
    const payload = normalizeRequestPayload(methodName, args)

    const span = this.startSpan('openai.request', {
      service: this.config.service,
      resource: methodName,
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
    })

    const fullStore = storage.getStore() || {} // certain request body fields are later used for logs
    const store = Object.create(null)
    fullStore.openai = store // namespacing these fields

    const tags = {} // The remaining tags are added one at a time

    // createChatCompletion, createCompletion, createImage, createImageEdit, createTranscription, createTranslation
    if ('prompt' in payload) {
      const prompt = payload.prompt
      store.prompt = prompt
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
    if ('input' in payload) {
      const normalized = normalizeStringOrTokenArray(payload.input, false)
      tags['openai.request.input'] = truncateText(normalized)
      store.input = normalized
    }

    // createChatCompletion, createCompletion
    if (typeof payload.logit_bias === 'object' && payload.logit_bias) {
      for (const [tokenId, bias] of Object.entries(payload.logit_bias)) {
        tags[`openai.request.logit_bias.${tokenId}`] = bias
      }
    }

    switch (methodName) {
      case 'createFineTune':
        createFineTuneRequestExtraction(tags, payload)
        break

      case 'createImage':
      case 'createImageEdit':
      case 'createImageVariation':
        commonCreateImageRequestExtraction(tags, payload, store)
        break

      case 'createChatCompletion':
        createChatCompletionRequestExtraction(tags, payload, store)
        break

      case 'createFile':
      case 'retrieveFile':
        commonFileRequestExtraction(tags, payload)
        break

      case 'createTranscription':
      case 'createTranslation':
        commonCreateAudioRequestExtraction(tags, payload, store)
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
        createEditRequestExtraction(tags, payload, store)
        break
    }

    span.addTags(tags)
  }

  finish ({ headers, body, method, path }) {
    const span = this.activeSpan
    const methodName = span._spanContext._tags['resource.name']

    body = coerceResponseBody(body, methodName)

    const fullStore = storage.getStore()
    const store = fullStore.openai

    const endpoint = lookupOperationEndpoint(methodName, path)

    const tags = {
      'openai.request.endpoint': endpoint,
      'openai.request.method': method,

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

    responseDataExtractionByMethod(methodName, tags, body, store)
    span.addTags(tags)

    super.finish()
    this.sendLog(methodName, span, tags, store, false)
    this.sendMetrics(headers, body, endpoint, span._duration)
  }

  error (...args) {
    super.error(...args)

    const span = this.activeSpan
    const methodName = span._spanContext._tags['resource.name']

    const fullStore = storage.getStore()
    const store = fullStore.openai

    // We don't know most information about the request when it fails

    const tags = ['error:1']
    this.metrics.distribution('openai.request.duration', span._duration * 1000, tags)
    this.metrics.increment('openai.request.error', 1, tags)

    this.sendLog(methodName, span, {}, store, true)
  }

  sendMetrics (headers, body, endpoint, duration) {
    const tags = [
      `org:${headers['openai-organization']}`,
      `endpoint:${endpoint}`, // just "/v1/models", no method
      `model:${headers['openai-model']}`,
      'error:0'
    ]

    this.metrics.distribution('openai.request.duration', duration * 1000, tags)

    if (body && ('usage' in body)) {
      const promptTokens = body.usage.prompt_tokens
      const completionTokens = body.usage.completion_tokens
      this.metrics.distribution('openai.tokens.prompt', promptTokens, tags)
      this.metrics.distribution('openai.tokens.completion', completionTokens, tags)
      this.metrics.distribution('openai.tokens.total', promptTokens + completionTokens, tags)
    }

    if ('x-ratelimit-limit-requests' in headers) {
      this.metrics.gauge('openai.ratelimit.requests', Number(headers['x-ratelimit-limit-requests']), tags)
    }

    if ('x-ratelimit-remaining-requests' in headers) {
      this.metrics.gauge('openai.ratelimit.remaining.requests', Number(headers['x-ratelimit-remaining-requests']), tags)
    }

    if ('x-ratelimit-limit-tokens' in headers) {
      this.metrics.gauge('openai.ratelimit.tokens', Number(headers['x-ratelimit-limit-tokens']), tags)
    }

    if ('x-ratelimit-remaining-tokens' in headers) {
      this.metrics.gauge('openai.ratelimit.remaining.tokens', Number(headers['x-ratelimit-remaining-tokens']), tags)
    }
  }

  sendLog (methodName, span, tags, store, error) {
    if (!Object.keys(store).length) return
    if (!this.sampler.isSampled()) return

    const log = {
      status: error ? 'error' : 'info',
      message: `sampled ${methodName}`,
      ...store
    }

    this.logger.log(log, span, tags)
  }
}

function createEditRequestExtraction (tags, payload, store) {
  const instruction = payload.instruction
  tags['openai.request.instruction'] = instruction
  store.instruction = instruction
}

function retrieveModelRequestExtraction (tags, payload) {
  tags['openai.request.id'] = payload.id
}

function createChatCompletionRequestExtraction (tags, payload, store) {
  if (!defensiveArrayLength(payload.messages)) return

  store.messages = payload.messages
  for (let i = 0; i < payload.messages.length; i++) {
    const message = payload.messages[i]
    tags[`openai.request.${i}.content`] = truncateText(message.content)
    tags[`openai.request.${i}.role`] = message.role
    tags[`openai.request.${i}.name`] = message.name
    tags[`openai.request.${i}.finish_reason`] = message.finish_reason
  }
}

function commonCreateImageRequestExtraction (tags, payload, store) {
  // createImageEdit, createImageVariation
  if (payload.file && typeof payload.file === 'object' && payload.file.path) {
    const file = path.basename(payload.file.path)
    tags['openai.request.image'] = file
    store.file = file
  }

  // createImageEdit
  if (payload.mask && typeof payload.mask === 'object' && payload.mask.path) {
    const mask = path.basename(payload.mask.path)
    tags['openai.request.mask'] = mask
    store.mask = mask
  }

  tags['openai.request.size'] = payload.size
  tags['openai.request.response_format'] = payload.response_format
  tags['openai.request.language'] = payload.language
}

function responseDataExtractionByMethod (methodName, tags, body, store) {
  switch (methodName) {
    case 'createModeration':
      createModerationResponseExtraction(tags, body)
      break

    case 'createCompletion':
    case 'createChatCompletion':
    case 'createEdit':
      commonCreateResponseExtraction(tags, body, store)
      break

    case 'listFiles':
    case 'listFineTunes':
    case 'listFineTuneEvents':
      commonListCountResponseExtraction(tags, body)
      break

    case 'createEmbedding':
      createEmbeddingResponseExtraction(tags, body)
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
    tags[`openai.response.images.${i}.url`] = truncateText(image.url)
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
  if (body.hyperparams) {
    tags['openai.response.hyperparams.n_epochs'] = body.hyperparams.n_epochs
    tags['openai.response.hyperparams.batch_size'] = body.hyperparams.batch_size
    tags['openai.response.hyperparams.prompt_loss_weight'] = body.hyperparams.prompt_loss_weight
    tags['openai.response.hyperparams.learning_rate_multiplier'] = body.hyperparams.learning_rate_multiplier
  }
  tags['openai.response.training_files_count'] = defensiveArrayLength(body.training_files)
  tags['openai.response.result_files_count'] = defensiveArrayLength(body.result_files)
  tags['openai.response.validation_files_count'] = defensiveArrayLength(body.validation_files)
  tags['openai.response.updated_at'] = body.updated_at
  tags['openai.response.status'] = body.status
}

// the OpenAI package appears to stream the content download then provide it all as a singular string
function downloadFileResponseExtraction (tags, body) {
  if (!body.file) return
  tags['openai.response.total_bytes'] = body.file.length
}

function deleteFileResponseExtraction (tags, body) {
  tags['openai.response.id'] = body.id
}

function commonCreateAudioRequestExtraction (tags, body, store) {
  tags['openai.request.response_format'] = body.response_format
  tags['openai.request.language'] = body.language

  if (body.file && typeof body.file === 'object' && body.file.path) {
    const filename = path.basename(body.file.path)
    tags['openai.request.filename'] = filename
    store.file = filename
  }
}

function commonFileRequestExtraction (tags, body) {
  tags['openai.request.purpose'] = body.purpose

  // User can provider either exact file contents or a file read stream
  // With the stream we extract the filepath
  // This is a best effort attempt to extract the filename during the request
  if (body.file && typeof body.file === 'object' && body.file.path) {
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

function createEmbeddingResponseExtraction (tags, body) {
  usageExtraction(tags, body)

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
function commonCreateResponseExtraction (tags, body, store) {
  usageExtraction(tags, body)

  if (!body.choices) return

  tags['openai.response.choices_count'] = body.choices.length

  store.choices = body.choices

  for (let i = 0; i < body.choices.length; i++) {
    const choice = body.choices[i]
    tags[`openai.response.choices.${i}.finish_reason`] = choice.finish_reason
    tags[`openai.response.choices.${i}.logprobs`] = ('logprobs' in choice) ? 'returned' : undefined
    tags[`openai.response.choices.${i}.text`] = truncateText(choice.text)

    // createChatCompletion only
    if ('message' in choice) {
      const message = choice.message
      tags[`openai.response.choices.${i}.message.role`] = message.role
      tags[`openai.response.choices.${i}.message.content`] = truncateText(message.content)
      tags[`openai.response.choices.${i}.message.name`] = truncateText(message.name)
    }
  }
}

// createCompletion, createChatCompletion, createEdit, createEmbedding
function usageExtraction (tags, body) {
  if (typeof body.usage !== 'object' || !body.usage) return
  tags['openai.response.usage.prompt_tokens'] = body.usage.prompt_tokens
  tags['openai.response.usage.completion_tokens'] = body.usage.completion_tokens
  tags['openai.response.usage.total_tokens'] = body.usage.total_tokens
}

function truncateApiKey (apiKey) {
  return apiKey && `sk-...${apiKey.substr(apiKey.length - 4)}`
}

/**
 * for cleaning up prompt and response
 */
function truncateText (text) {
  if (!text) return

  text = text
    .replace(RE_NEWLINE, '\\n')
    .replace(RE_TAB, '\\t')

  if (text.length > MAX_TEXT_LEN) {
    return text.substring(0, MAX_TEXT_LEN) + '...'
  }

  return text
}

// The server almost always responds with JSON
function coerceResponseBody (body, methodName) {
  switch (methodName) {
    case 'downloadFile':
      return { file: body }
  }

  return typeof body === 'object' ? body : {}
}

// This method is used to replace a dynamic URL segment with an asterisk
function lookupOperationEndpoint (operationId, url) {
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
      return '/v1/fine-tunes/*'

    case 'listFineTuneEvents':
      return '/v1/fine-tunes/*/events'

    case 'cancelFineTune':
      return '/v1/fine-tunes/*/cancel'
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
    case 'listFiles':
    case 'listFineTunes':
      // no argument
      return {}

    case 'retrieveModel':
      return { id: args[0] }

    case 'createFile':
      return {
        file: args[0],
        purpose: args[1]
      }

    case 'deleteFile':
    case 'retrieveFile':
    case 'downloadFile':
      return { file_id: args[0] }

    case 'listFineTuneEvents':
      return {
        fine_tune_id: args[0],
        stream: args[1] // undocumented
      }

    case 'retrieveFineTune':
    case 'deleteModel':
    case 'cancelFineTune':
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
  return truncate ? truncateText(normalized) : normalized
}

function defensiveArrayLength (maybeArray) {
  return Array.isArray(maybeArray) ? maybeArray.length : undefined
}

module.exports = OpenApiPlugin
