'use strict'

const useDebugLogs = process.env.DD_OPENAI_MOCK_SERVER_DEBUG_LOGS

const express = require('express')
const fs = require('node:fs')
const path = require('node:path')
const app = express()

app.use(express.json())

/** @type {import('http').Server} */
let server

/** @type {Set<import('net').Socket>} */
const connections = new Set()

const debug = (...args) => {
  if (useDebugLogs) {
    // eslint-disable-next-line no-console
    console.log(...args)
  }
}

app.post('/v1/completions', (req, res) => {
  const { model, n = 1, stream = false, stream_options: streamOptions = {} } = req.body

  if (stream) {
    // streamed responses are pre-recorded in a separate directory
    res.setHeaders(new Map([
      ['Content-Type', 'text/plain'],
      ['openai-model', model],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))

    let file
    if (streamOptions.include_usage) {
      file = 'completions.simple.usage.txt'
    } else {
      file = 'completions.simple.txt'
    }

    const filePath = path.join(__dirname, 'streamed-responses', file)
    const readStream = fs.createReadStream(filePath)

    readStream.pipe(res)

    readStream.on('end', () => res.end())
    readStream.on('error', (err) => {
      res.status(500).end('Error streaming file')
    })

    return
  }

  const choices = []

  for (let i = 0; i < n; i++) {
    choices.push({
      text: '\n\nHello, world!',
      index: i,
      logprobs: null,
      finish_reason: 'stop'
    })
  }

  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-model', model],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01'],
      ['x-ratelimit-limit-requests', '3000'],
      ['x-ratelimit-limit-tokens', '250000'],
      ['x-ratelimit-remaining-requests', '2999'],
      ['x-ratelimit-remaining-tokens', '249984'],
      ['x-ratelimit-reset-requests', '20ms'],
      ['x-ratelimit-reset-tokens', '3ms']
    ]))
    .json({
      id: 'mock-completion-id',
      object: 'text_completion',
      created: Date.now(),
      model,
      choices,
      usage: {
        prompt_tokens: 3,
        completion_tokens: 16,
        total_tokens: 19
      }
    })
})

app.post('/v1/chat/completions', (req, res) => {
  const { model, tools, stream = false, n = 1, stream_options: streamOptions = {} } = req.body

  if (stream) {
    // streamed responses are pre-recorded in a separate directory
    res.setHeaders(new Map([
      ['Content-Type', 'text/plain'],
      ['openai-model', model],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))

    let file
    if (n > 1) {
      file = 'chat.completions.multiple.txt'
    } else if (n === 0) {
      file = 'chat.completions.empty.txt'
    } else if (streamOptions.include_usage) {
      file = 'chat.completions.simple.usage.txt'
    } else if (tools) {
      file = tools.length ? 'chat.completions.tools.txt' : 'chat.completions.tools.and.content.txt'
    } else {
      file = 'chat.completions.simple.txt'
    }

    const filePath = path.join(__dirname, 'streamed-responses', file)
    const readStream = fs.createReadStream(filePath)

    readStream.pipe(res)

    readStream.on('end', () => res.end())
    readStream.on('error', (err) => {
      res.status(500).end('Error streaming file')
    })

    return
  }

  const response = {
    id: 'mock-chat-completion-id',
    object: 'chat.completion',
    created: Date.now(),
    model,
    usage: {
      prompt_tokens: 37,
      completion_tokens: 10,
      total_tokens: 47
    },
    choices: [{
      message: {
        role: 'assistant',
        content: 'Hello, world!'
      },
      finish_reason: 'stop',
      index: 0
    }]
  }

  if (tools) {
    const toolCalls = []

    for (let idx = 0; idx < tools.length; idx++) {
      const tool = tools[idx]
      toolCalls.push({
        id: `tool-${idx + 1}`,
        type: 'function',
        function: {
          name: tool.function.name,
          arguments: JSON.stringify(Object.keys(tool.function.parameters.properties).reduce((acc, argName) => {
            acc[argName] = 'some-value'
            return acc
          }, {}))
        }
      })
    }

    response.choices[0].message.tool_calls = toolCalls
    response.choices[0].finish_reason = 'tool_calls'
    response.choices[0].message.content = null
  }

  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-model', model],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))
    .json(response)
})

app.post('/v1/embeddings', (req, res) => {
  const { model, input = '' } = req.body

  const inputTokens = input.split(' ').length
  const usage = {
    prompt_tokens: inputTokens,
    total_tokens: inputTokens
  }

  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-model', model],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))
    .json({
      object: 'list',
      data: [{
        object: 'embedding',
        index: 0,
        embedding: Array(1536).fill(0)
      }],
      model,
      usage
    })
})

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      {
        id: 'model-1',
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
        root: 'model-1',
        parent: null
      },
      {
        id: 'model-2',
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
        root: 'model-2',
        parent: null
      }
    ]
  })
})

app.get('/v1/models/:id', (req, res) => {
  const { id } = req.params

  res.json({
    id,
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
    parent: 'gpt-4'
  })
})

app.delete('/v1/models/:id', (req, res) => {
  const { id } = req.params
  res.json({
    object: 'model',
    id,
    deleted: true
  })
})

app.post('/v1/edits', (req, res) => {
  const { input, model } = req.body

  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-model', model],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01'],
      ['x-ratelimit-limit-requests', '20'],
      ['x-ratelimit-remaining-requests', '19']
    ]))
    .json({
      object: 'edit',
      created: 1684267309,
      choices: [{
        text: `Edited: ${input}\n`,
        index: 0
      }],
      usage: {
        prompt_tokens: 25,
        completion_tokens: 28,
        total_tokens: 53
      }
    })
})

app.get('/v1/files', (req, res) => {
  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))
    .json({
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
    })
})

app.post('/v1/files', (req, res) => {
  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))
    .json({
      object: 'file',
      id: 'file-268aYWYhvxWwHb4nIzP9FHM6',
      purpose: 'fine-tune',
      filename: 'dave-hal.jsonl',
      bytes: 356,
      created_at: 1684362764,
      status: 'uploaded',
      status_details: 'foo' // dummy value for testing
    })
})

app.delete('/v1/files/:id', (req, res) => {
  const { id } = req.params
  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))
    .json({
      object: 'file',
      id,
      deleted: true
    })
})

app.get('/v1/files/:id', (req, res) => {
  const { id } = req.params

  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))
    .json({
      object: 'file',
      id,
      purpose: 'fine-tune',
      filename: 'dave-hal.jsonl',
      bytes: 356,
      created_at: 1684362764,
      status: 'uploaded',
      status_details: 'foo' // dummy value for testing
    })
})

app.get('/v1/files/:id/content', (req, res) => {
  res
    .setHeaders(new Map([
      ['Content-Type', 'text/octet-stream'],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01'],
      ['content-disposition', 'attachment; filename="dave-hal.jsonl"']
    ]))
    .send('{"prompt": "foo?", "completion": "bar."}\n{"prompt": "foofoo?", "completion": "barbar."}\n')
})

app.post('/v1/fine_tuning/jobs', (req, res) => {
  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))
    .json({
      object: 'fine-tunes',
      id: 'ft-10RCfqSvgyEcauomw7VpiYco',
      created_at: 1684442489,
      updated_at: 1684442489,
      organization_id: 'datadog',
      model: 'curie',
      fine_tuned_model: 'huh',
      status: 'pending',
      result_files: [],
      hyperparameters: {
        n_epochs: 5,
        batch_size: 3,
        prompt_loss_weight: 0.01,
        learning_rate_multiplier: 0.1
      },
      validation_file: null,
      training_file: 'file-t3k1gVSQDHrfZnPckzftlZ4A'
    })
})

app.post('/v1/fine-tunes', (req, res) => {
  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))
    .json({
      object: 'fine_tuning.job',
      id: 'ft-10RCfqSvgyEcauomw7VpiYco',
      created_at: 1684442489,
      updated_at: 1684442489,
      organization_id: 'datadog',
      model: 'curie',
      fine_tuned_model: 'huh',
      status: 'pending',
      result_files: [],
      hyperparams: {
        n_epochs: 5,
        batch_size: 3,
        prompt_loss_weight: 0.01,
        learning_rate_multiplier: 0.1
      },
      validation_file: [],
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
      events: [{
        object: 'fine-tune-event',
        level: 'info',
        message: 'Created fine-tune: ft-10RCfqSvgyEcauomw7VpiYco',
        created_at: 1684442489
      }]
    })
})

app.get('/v1/fine_tuning/jobs/:id', (req, res) => {
  const { id } = req.params
  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))
    .json({
      id,
      object: 'fine-tuning.job',
      organization_id: 'datadog',
      model: 'curie',
      created_at: 1684442489,
      updated_at: 1684442697,
      status: 'succeeded',
      fine_tuned_model: 'curie:ft-foo:deleteme-2023-05-18-20-44-56',
      hyperparameters: {
        n_epochs: 4,
        batch_size: 3,
        prompt_loss_weight: 0.01,
        learning_rate_multiplier: 0.1
      },
      result_files: [
        'file-bJyf8TM0jeSZueBo4jpodZVQ'
      ],
      validation_files: null,
      training_file: 'file-t3k1gVSQDHrfZnPckzftlZ4A'
    })
})

app.get('/v1/fine-tunes/:id', (req, res) => {
  const { id } = req.params

  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))
    .json({
      id,
      object: 'fine-tune',
      organization_id: 'datadog',
      model: 'curie',
      created_at: 1684442489,
      updated_at: 1684442697,
      status: 'succeeded',
      fine_tuned_model: 'curie:ft-foo:deleteme-2023-05-18-20-44-56',
      hyperparams: {
        n_epochs: 4,
        batch_size: 3,
        prompt_loss_weight: 0.01,
        learning_rate_multiplier: 0.1
      },
      result_files: [{}],
      validation_files: [],
      training_files: [{}],
      events: Array(11).fill({})
    })
})

app.get('/v1/fine_tuning/jobs', (req, res) => {
  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))
    .json({
      object: 'list',
      data: [{
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
        organization_id: 'datadog',
        model: 'curie',
        fine_tuned_model: 'curie:ft-foo:deleteme-2023-05-18-20-44-56',
        result_files: [],
        status: 'succeeded',
        validation_file: null,
        training_file: 'file-t3k1gVSQDHrfZnPckzftlZ4A'
      }]
    })
})

app.get('/v1/fine-tunes', (req, res) => {
  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))
    .json({
      object: 'list',
      data: [{
        object: 'fine-tune',
        id: 'ft-10RCfqSvgyEcauomw7VpiYco',
        hyperparams: {
          n_epochs: 4,
          batch_size: 3,
          prompt_loss_weight: 0.01,
          learning_rate_multiplier: 0.1
        },
        organization_id: 'datadog',
        model: 'curie',
        training_files: [{}],
        validation_files: [],
        result_files: [{}],
        created_at: 1684442489,
        updated_at: 1684442697,
        status: 'succeeded',
        fine_tuned_model: 'curie:ft-foo:deleteme-2023-05-18-20-44-56'
      }]
    })
})

app.get('/v1/fine_tuning/jobs/:id/events', (req, res) => {
  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))
    .json({
      object: 'list',
      data: Array(11).fill({ object: 'fine_tuning.job.event' })
    })
})

app.get('/v1/fine-tunes/:id/events', (req, res) => {
  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))
    .json({
      object: 'list',
      data: Array(11).fill({ object: 'fine-tune-event' })
    })
})

app.post('/v1/fine_tuning/jobs/:id/cancel', (req, res) => {
  const { id } = req.params

  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))
    .json({
      id,
      object: 'fine-tuning.job',
      organization_id: 'datadog',
      model: 'curie',
      created_at: 1684452102,
      updated_at: 1684452103,
      status: 'cancelled',
      fine_tuned_model: 'model',
      hyperparameters: {
        n_epochs: 4,
        batch_size: 3,
        prompt_loss_weight: 0.01,
        learning_rate_multiplier: 0.1
      },
      result_files: [],
      validation_files: null,
      training_file: 'file-t3k1gVSQDHrfZnPckzftlZ4A'
    })
})

app.post('/v1/fine-tunes/:id/cancel', (req, res) => {
  const { id } = req.params

  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))
    .json({
      id,
      object: 'fine-tune',
      organization_id: 'datadog',
      model: 'curie',
      created_at: 1684452102,
      updated_at: 1684452103,
      status: 'cancelled',
      fine_tuned_model: 'model',
      hyperparams: {
        n_epochs: 4,
        batch_size: 3,
        prompt_loss_weight: 0.01,
        learning_rate_multiplier: 0.1
      },
      training_files: [{ id: 'file-t3k1gVSQDHrfZnPckzftlZ4A' }],
      result_files: [],
      validation_files: [],
      events: Array(2).fill({ object: 'fine-tune-event' })
    })
})

/**
 * Starts the mock OpenAI server
 * @returns {Promise<number>} The port the server is listening on
 */
function startMockServer () {
  return new Promise((resolve, reject) => {
    server = app.listen(0, 'localhost', (err) => {
      if (err) {
        return reject(err)
      }
      server.on('connection', connection => {
        connections.add(connection)
        connection.on('close', () => {
          connections.delete(connection)
        })
      })

      debug(`Mock OpenAI server started on http://localhost:${server.address().port}`)
      resolve(server.address().port)
    })
  })
}

app.post('/v1/moderations', (req, res) => {
  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))
    .json({
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
    })
})

app.post('/v1/images/generations', (req, res) => {
  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))
    .json({
      created: 1684270747,
      data: [{
        url: 'https://oaidalleapiprodscus.blob.core.windows.net/private/org-COOLORG/user-FOO/img-foo.png',
        b64_json: 'foobar==='
      }]
    })
})

app.post('/v1/images/edits', (req, res) => {
  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))
    .json({
      created: 1684850118,
      data: [{
        url: 'https://oaidalleapiprodscus.blob.core.windows.net/private/org-COOLORG/user-FOO/img-bar.png',
        b64_json: 'fOoF0f='
      }]
    })
})

app.post('/v1/images/variations', (req, res) => {
  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))
    .json({
      created: 1684853320,
      data: [{
        url: 'https://oaidalleapiprodscus.blob.core.windows.net/private/org-COOLORG/user-FOO/img-soup.png',
        b64_json: 'foo='
      }]
    })
})

app.post('/v1/audio/transcriptions', (req, res) => {
  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))
    .json({
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
    })
})

app.post('/v1/audio/translations', (req, res) => {
  res
    .setHeaders(new Map([
      ['Content-Type', 'application/json'],
      ['openai-organization', 'datadog'],
      ['openai-version', '2023-10-01']
    ]))
    .json({
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
    })
})
/**
 * Stops the mock OpenAI server
 * @returns {Promise<void>}
 */
function stopMockServer () {
  for (const connection of connections) {
    connection.destroy()
  }
  connections.clear()

  if (!server) return Promise.resolve()

  return new Promise((resolve, reject) => {
    server.close((err) => {
      debug('Mock OpenAI server closed')
      if (err) {
        return reject(err)
      }
      server = null
      resolve()
    })
  })
}

module.exports = {
  startMockServer,
  stopMockServer
}
