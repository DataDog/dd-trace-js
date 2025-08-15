'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const dc = require('dc-polyfill')
const ch = dc.tracingChannel('apm:anthropic:request')
const onStreamedChunkCh = dc.channel('apm:anthropic:request:chunk')

const ANTHROPIC_PACKAGE_SHIMS = [
  {
    file: 'resources/messages',
    targetClass: 'Messages',
    baseResource: 'messages',
    methods: ['create'],
    streamedResponse: true
  }
]

/**
 * For streamed responses, we need to accumulate all of the content in
 * the chunks, and let the combined content be the final response.
 * This way, spans look the same as when not streamed.
 */
function wrapStreamIterator (response, options, ctx) {
  return function (itr) {
    return function () {
      const iterator = itr.apply(this, arguments)
      shimmer.wrap(iterator, 'next', next => function () {
        return next.apply(this, arguments)
          .then(res => {
            const { done, value: chunk } = res
            onStreamedChunkCh.publish({ ctx, chunk, done })

            if (done) {
              finish(ctx, {
                headers: response.headers,
                request: {
                  path: response.url,
                  method: options.method
                }
              })
            }

            return res
          })
          .catch(err => {
            finish(ctx, undefined, err)

            throw err
          })
      })
      return iterator
    }
  }
}

const extensions = ['.js', '.mjs']

for (const extension of extensions) {
  for (const shim of ANTHROPIC_PACKAGE_SHIMS) {
    const { file, targetClass, baseResource, methods, versions, streamedResponse } = shim
    addHook({ name: '@anthropic-ai/sdk', file: file + extension, versions: versions || ['>=0.6.0'] }, exports => {
      const targetPrototype = exports[targetClass].prototype

      for (const methodName of methods) {
        shimmer.wrap(targetPrototype, methodName, methodFn => function () {
          if (!ch.start.hasSubscribers) {
            return methodFn.apply(this, arguments)
          }

          // The Anthropic library lets you set `stream: true` on the options arg
          const stream = streamedResponse && getOption(arguments, 'stream', false)

          const client = this._client || this.client

          const ctx = {
            methodName: `${baseResource}.${methodName}`,
            args: arguments,
            basePath: client.baseURL || 'https://api.anthropic.com',
          }

          return ch.start.runStores(ctx, () => {
            const apiProm = methodFn.apply(this, arguments)

            return apiProm
              .then(response => {
                if (stream) {
                  // Handle streaming response
                  if (response.body && response.body[Symbol.asyncIterator]) {
                    shimmer.wrap(
                      response.body, Symbol.asyncIterator, wrapStreamIterator(response, { method: 'POST' }, ctx)
                    )
                  }
                } else {
                  // Handle non-streaming response
                  finish(ctx, {
                    headers: response.response?.headers || {},
                    data: response,
                    request: {
                      path: ctx.basePath + '/v1/messages',
                      method: 'POST'
                    }
                  })
                }

                return response
              })
              .catch(error => {
                finish(ctx, undefined, error)
                throw error
              })
          })
        })
      }
      return exports
    })
  }
}

function finish (ctx, response, error) {
  if (error) {
    ctx.error = error
    ch.error.publish(ctx)
  }

  // for successful streamed responses, we've already set the result on ctx.body,
  // so we don't want to override it here
  ctx.result ??= {}
  Object.assign(ctx.result, response)

  ch.asyncEnd.publish(ctx)
}

function getOption (args, option, defaultValue) {
  return args[0]?.[option] || defaultValue
}