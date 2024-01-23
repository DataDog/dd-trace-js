'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const startCh = channel('apm:openai:request:start')
const finishCh = channel('apm:openai:request:finish')
const errorCh = channel('apm:openai:request:error')

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

const V4_PACKAGE_SHIMS = [
  {
    file: 'resources/chat/completions.js',
    targetClass: 'Completions',
    methods: ['create']
  },
  {
    file: 'resources/completions.js',
    targetClass: 'Completions',
    methods: ['create']
  },
  {
    file: 'resources/embeddings.js',
    targetClass: 'Embeddings',
    methods: ['create']
  },
  {
    file: 'resources/files.js',
    targetClass: 'Files',
    methods: ['create', 'del', 'list', 'retrieve', 'retrieveContent']
  },
  {
    file: 'resources/images.js',
    targetClass: 'Images',
    methods: ['createVariation', 'edit', 'generate']
  },
  {
    file: 'resources/fine-tuning/jobs.js',
    targetClass: 'Jobs',
    methods: ['cancel', 'create', 'list', 'listEvents', 'retrieve']
  },
  {
    file: 'resources/models.js',
    targetClass: 'Models',
    methods: ['del', 'list', 'retrieve']
  },
  {
    file: 'resources/moderation.js',
    targetClass: 'Moderations',
    methods: ['create']
  },
  {
    file: 'resources/audio/transcriptions.js',
    targetClass: 'Transcriptions',
    methods: ['create']
  },
  {
    file: 'resources/audio/translations.js',
    targetClass: 'Translations',
    methods: ['create']
  }
]

for (const packageFile of V4_PACKAGE_SHIMS) {
  addHook({ name: 'openai', file: packageFile.file, versions: ['>=4'] }, exports => {
    const targetPrototype = exports[packageFile.targetClass].prototype

    for (const methodName of packageFile.methods) {
      shimmer.wrap(targetPrototype, methodName, fn => function () {
        if (!startCh.hasSubscribers) {
          return fn.apply(this, arguments)
        }

        startCh.publish({
          methodName,
          args: arguments,
          basePath: this.client.baseURL,
          apiKey: this.client.apiKey
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
            errorCh.publish({err})

            throw err
          })
      })
    }
    return exports
  })
}
