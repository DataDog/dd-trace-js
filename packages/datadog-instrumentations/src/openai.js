'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:openai:request:start')
const finishCh = channel('apm:openai:request:finish')
const errorCh = channel('apm:openai:request:error')

const V4_PACKAGE_SHIMS = [
  {
    file: 'resources/chat/completions.js',
    targetClass: 'Completions',
    object: 'chat.completions',
    methods: ['create']
  },
  {
    file: 'resources/completions.js',
    targetClass: 'Completions',
    object: 'completions',
    methods: ['create']
  },
  {
    file: 'resources/embeddings.js',
    targetClass: 'Embeddings',
    object: 'embeddings',
    methods: ['create']
  },
  {
    file: 'resources/files.js',
    targetClass: 'Files',
    object: 'files',
    methods: ['create', 'del', 'list', 'retrieve', 'retrieveContent']
  },
  {
    file: 'resources/images.js',
    targetClass: 'Images',
    object: 'images',
    methods: ['createVariation', 'edit', 'generate']
  },
  {
    file: 'resources/fine-tuning/jobs.js',
    targetClass: 'Jobs',
    object: 'fineTuning.jobs',
    methods: ['cancel', 'create', 'list', 'listEvents', 'retrieve']
  },
  {
    file: 'resources/models.js',
    targetClass: 'Models',
    object: 'models',
    methods: ['del', 'list', 'retrieve']
  },
  {
    file: 'resources/moderation.js',
    targetClass: 'Moderations',
    object: 'moderation',
    methods: ['create']
  },
  {
    file: 'resources/audio/transcriptions.js',
    targetClass: 'Transcriptions',
    object: 'audio.transcriptions',
    methods: ['create']
  },
  {
    file: 'resources/audio/translations.js',
    targetClass: 'Translations',
    object: 'audio.translations',
    methods: ['create']
  }
]

addHook({ name: 'openai', file: 'dist/api.js', versions: ['>=3.0.0 <4'] }, exports => {
  const methodNames = Object.getOwnPropertyNames(exports.OpenAIApi.prototype)
  methodNames.shift() // remove leading 'constructor' method

  for (const methodName of methodNames) {
    shimmer.wrap(exports.OpenAIApi.prototype, methodName, fn => function () {
      if (!startCh.hasSubscribers) {
        return fn.apply(this, arguments)
      }

      startCh.publish({
        methodName,
        args: arguments,
        basePath: this.basePath,
        apiKey: this.configuration.apiKey
      })

      return fn.apply(this, arguments)
        .then((response) => {
          finishCh.publish({
            headers: response.headers,
            body: response.data,
            path: response.request.path,
            method: response.request.method
          })

          return response
        })
        .catch((err) => {
          errorCh.publish({ err })

          throw err
        })
    })
  }

  return exports
})

for (const { file, targetClass, object, methods } of V4_PACKAGE_SHIMS) {
  addHook({ name: 'openai', file, versions: ['>=4'] }, exports => {
    const targetPrototype = exports[targetClass].prototype

    for (const methodName of methods) {
      shimmer.wrap(targetPrototype, methodName, methodFn => function () {
        if (!startCh.hasSubscribers) {
          return methodFn.apply(this, arguments)
        }

        const client = this._client || this.client

        startCh.publish({
          methodName: `${object}.${methodName}`,
          args: arguments,
          basePath: client.baseURL,
          apiKey: client.apiKey
        })

        const apiProm = methodFn.apply(this, arguments)

        let headers, method, path

        shimmer.wrap(apiProm, 'then', origApiPromThen => function () {
          return this.responsePromise
            .then(({ response, options }) => {
              headers = response.headers
              method = options.method
              path = response.url
            })
            .then(() => origApiPromThen.apply(this, arguments))
        })

        return apiProm
          .then((response) => {
            finishCh.publish({
              headers,
              body: response,
              path,
              method
            })

            shimmer.unwrap(apiProm, 'then')

            return response
          })
          .catch((err) => {
            errorCh.publish({ err })

            throw err
          })
      })
    }
    return exports
  })
}
