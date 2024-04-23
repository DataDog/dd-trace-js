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
    baseResource: 'chat.completions',
    methods: ['create']
  },
  {
    file: 'resources/completions.js',
    targetClass: 'Completions',
    baseResource: 'completions',
    methods: ['create']
  },
  {
    file: 'resources/embeddings.js',
    targetClass: 'Embeddings',
    baseResource: 'embeddings',
    methods: ['create']
  },
  {
    file: 'resources/files.js',
    targetClass: 'Files',
    baseResource: 'files',
    methods: ['create', 'del', 'list', 'retrieve']
  },
  {
    file: 'resources/files.js',
    targetClass: 'Files',
    baseResource: 'files',
    methods: ['retrieveContent'],
    versions: ['>=4.0.0 <4.17.1']
  },
  {
    file: 'resources/files.js',
    targetClass: 'Files',
    baseResource: 'files',
    methods: ['content'], // replaced `retrieveContent` in v4.17.1
    versions: ['>=4.17.1']
  },
  {
    file: 'resources/images.js',
    targetClass: 'Images',
    baseResource: 'images',
    methods: ['createVariation', 'edit', 'generate']
  },
  {
    file: 'resources/fine-tuning/jobs/jobs.js',
    targetClass: 'Jobs',
    baseResource: 'fine_tuning.jobs',
    methods: ['cancel', 'create', 'list', 'listEvents', 'retrieve'],
    versions: ['>=4.34.0'] // file location changed in 4.34.0
  },
  {
    file: 'resources/fine-tuning/jobs.js',
    targetClass: 'Jobs',
    baseResource: 'fine_tuning.jobs',
    methods: ['cancel', 'create', 'list', 'listEvents', 'retrieve'],
    versions: ['>=4.1.0 <4.34.0']
  },
  {
    file: 'resources/fine-tunes.js', // deprecated after 4.1.0
    targetClass: 'FineTunes',
    baseResource: 'fine-tune',
    methods: ['cancel', 'create', 'list', 'listEvents', 'retrieve'],
    versions: ['>=4.0.0 <4.1.0']
  },
  {
    file: 'resources/models.js',
    targetClass: 'Models',
    baseResource: 'models',
    methods: ['del', 'list', 'retrieve']
  },
  {
    file: 'resources/moderations.js',
    targetClass: 'Moderations',
    baseResource: 'moderations',
    methods: ['create']
  },
  {
    file: 'resources/audio/transcriptions.js',
    targetClass: 'Transcriptions',
    baseResource: 'audio.transcriptions',
    methods: ['create']
  },
  {
    file: 'resources/audio/translations.js',
    targetClass: 'Translations',
    baseResource: 'audio.translations',
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

for (const shim of V4_PACKAGE_SHIMS) {
  const { file, targetClass, baseResource, methods } = shim
  addHook({ name: 'openai', file, versions: shim.versions || ['>=4'] }, exports => {
    const targetPrototype = exports[targetClass].prototype

    for (const methodName of methods) {
      shimmer.wrap(targetPrototype, methodName, methodFn => function () {
        if (!startCh.hasSubscribers) {
          return methodFn.apply(this, arguments)
        }

        const client = this._client || this.client

        startCh.publish({
          methodName: `${baseResource}.${methodName}`,
          args: arguments,
          basePath: client.baseURL,
          apiKey: client.apiKey
        })

        const apiProm = methodFn.apply(this, arguments)

        // wrapping `parse` avoids problematic wrapping of `then` when trying to call
        // `withResponse` in userland code after. This way, we can return the whole `APIPromise`
        shimmer.wrap(apiProm, 'parse', origApiPromParse => function () {
          return origApiPromParse.apply(this, arguments)
            // the original response is wrapped in a promise, so we need to unwrap it
            .then(body => Promise.all([this.responsePromise, body]))
            .then(([{ response, options }, body]) => {
              finishCh.publish({
                headers: response.headers,
                body,
                path: response.url,
                method: options.method
              })

              return body
            })
            .catch(err => {
              errorCh.publish({ err })

              throw err
            })
            .finally(() => {
              // maybe we don't want to unwrap here in case the promise is re-used?
              // other hand: we want to avoid resource leakage
              shimmer.unwrap(apiProm, 'parse')
            })
        })

        return apiProm
      })
    }
    return exports
  })
}
