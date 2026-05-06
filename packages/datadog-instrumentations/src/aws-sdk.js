'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

const patchedClientConfigProtocols = new WeakSet()
const patchedCommandPrototypes = new WeakSet()

// Resource identifiers that already match the channel-suffix slug. Anything
// else falls back to `'default'`. Hoisted out of the per-call hot path so we
// don't allocate a fresh Array literal + run `.includes` on every AWS send.
const KNOWN_CHANNEL_SUFFIXES = new Set([
  'cloudwatchlogs',
  'dynamodb',
  'eventbridge',
  'kinesis',
  'lambda',
  'redshift',
  's3',
  'sfn',
  'sns',
  'sqs',
  'states',
  'stepfunctions',
  'bedrockruntime',
])

/**
 * @typedef {object} ChannelBag
 * @property {ReturnType<typeof channel>} start
 * @property {ReturnType<typeof channel>} complete
 * @property {ReturnType<typeof channel>} region
 * @property {ReturnType<typeof channel>} responseStart
 * @property {ReturnType<typeof channel>} responseFinish
 * @property {ReturnType<typeof channel>} deserialize
 * @property {ReturnType<typeof channel>} streamedChunk
 */

/** @type {Map<string, ChannelBag>} */
const channelBags = new Map()

/**
 * Returns the cached set of diagnostic-channel handles for a given AWS
 * service slug. Each `channel(...)` call hashes the channel name into a
 * shared registry and allocates a per-call template-literal string; doing
 * that ~8 times per AWS send was a measurable per-request cost.
 *
 * @param {string} suffix
 * @returns {ChannelBag}
 */
function getChannelBag (suffix) {
  let bag = channelBags.get(suffix)
  if (bag === undefined) {
    bag = {
      start: channel(`apm:aws:request:start:${suffix}`),
      complete: channel(`apm:aws:request:complete:${suffix}`),
      region: channel(`apm:aws:request:region:${suffix}`),
      responseStart: channel(`apm:aws:response:start:${suffix}`),
      responseFinish: channel(`apm:aws:response:finish:${suffix}`),
      deserialize: channel(`apm:aws:response:deserialize:${suffix}`),
      streamedChunk: channel(`apm:aws:response:streamed-chunk:${suffix}`),
    }
    channelBags.set(suffix, bag)
  }
  return bag
}

/** @type {WeakMap<Function, string>} */
const clientNameCache = new WeakMap()

/**
 * @param {Function} clientCtor
 * @returns {string}
 */
function getClientName (clientCtor) {
  let name = clientNameCache.get(clientCtor)
  if (name === undefined) {
    name = clientCtor.name.replace(/Client$/, '')
    clientNameCache.set(clientCtor, name)
  }
  return name
}

/** @type {WeakMap<Function, string>} */
const operationCache = new WeakMap()

/**
 * @param {Function} commandCtor
 * @returns {string}
 */
function getOperationName (commandCtor) {
  let operation = operationCache.get(commandCtor)
  if (operation === undefined) {
    const commandName = commandCtor.name
    operation = `${commandName[0].toLowerCase()}${commandName.slice(1).replace(/Command$/, '')}`
    operationCache.set(commandCtor, operation)
  }
  return operation
}

function wrapRequest (send) {
  // V8 deopts both this function and `send.apply(this, arguments)` once
  // `arguments[0] = wrapCb(...)` materialises the arguments object on the
  // hot path. Pass the (at most one-arg) call site through explicitly --
  // `Request.send` only accepts an optional callback in both v2 and v3 SDKs.
  return function wrappedRequest (cb) {
    if (!this.service) return send.apply(this, arguments)

    const serviceIdentifier = this.service.serviceIdentifier
    const channelSuffix = getChannelSuffix(serviceIdentifier)
    const channels = getChannelBag(channelSuffix)
    if (!channels.start.hasSubscribers) return send.apply(this, arguments)

    const cbExists = typeof cb === 'function'
    const ctx = {
      serviceIdentifier,
      operation: this.operation,
      awsRegion: this.service.config && this.service.config.region,
      awsService: this.service.api && this.service.api.className,
      request: this,
      cbExists,
    }

    // AWS SDK v2 mixes in its own `SequentialExecutor` (no `once`), so stick
    // to `on('complete')`. The event fires exactly once per Request — even
    // across retries — so we don't get duplicate publishes.
    this.on('complete', response => {
      ctx.response = response
      channels.complete.publish(ctx)
    })

    if (cbExists) {
      return channels.start.runStores(ctx, send, this, wrapCb(cb, channels, ctx))
    }
    return channels.start.runStores(ctx, send, this)
  }
}

function wrapDeserialize (deserialize, headersCh, responseIndex = 0) {
  return function () {
    const response = arguments[responseIndex]
    if (headersCh.hasSubscribers) {
      headersCh.publish({ headers: response.headers })
    }

    return deserialize.apply(this, arguments)
  }
}

function wrapSmithySend (send) {
  return function (command, ...args) {
    const cb = args.at(-1)
    const serviceIdentifier = this.config.serviceId.toLowerCase()
    const channelSuffix = getChannelSuffix(serviceIdentifier)
    const channels = getChannelBag(channelSuffix)
    const clientName = getClientName(this.constructor)
    const operation = getOperationName(command.constructor)
    const request = {
      operation,
      params: command.input,
    }

    if (typeof command.deserialize === 'function') {
      const proto = Object.getPrototypeOf(command)
      // Wrap once per Command class via the prototype when `deserialize` is
      // inherited; fall back to per-instance wrap when a command shadows it
      // as an own property (rare in @aws-sdk v3).
      if (proto && proto.deserialize === command.deserialize) {
        if (!patchedCommandPrototypes.has(proto)) {
          shimmer.wrap(proto, 'deserialize', deserialize => wrapDeserialize(deserialize, channels.deserialize))
          patchedCommandPrototypes.add(proto)
        }
      } else {
        shimmer.wrap(command, 'deserialize', deserialize => wrapDeserialize(deserialize, channels.deserialize))
      }
    } else if (this.config?.protocol?.deserializeResponse && !patchedClientConfigProtocols.has(this.config.protocol)) {
      shimmer.wrap(
        this.config.protocol,
        'deserializeResponse',
        deserializeResponse => wrapDeserialize(deserializeResponse, channels.deserialize, 2)
      )

      patchedClientConfigProtocols.add(this.config.protocol)
    }

    const ctx = {
      serviceIdentifier,
      operation,
      awsService: clientName,
      request,
    }

    return channels.start.runStores(ctx, () => {
      // When the region is not set this never resolves so we can't await.
      this.config.region().then(region => {
        ctx.region = region
        channels.region.publish(ctx)
      })

      if (typeof cb === 'function') {
        args[args.length - 1] = shimmer.wrapFunction(cb, cb => function (err, result) {
          addResponse(ctx, err, result)

          handleCompletion(result, ctx, channels)

          const responseCtx = { request, response: ctx.response }

          channels.responseStart.runStores(responseCtx, () => {
            cb.apply(this, arguments)

            channels.responseFinish.publish(responseCtx)
          })
        })
      } else { // always a promise
        return send.call(this, command, ...args)
          .then(
            result => {
              addResponse(ctx, null, result)
              handleCompletion(result, ctx, channels)
              return result
            },
            error => {
              addResponse(ctx, error)
              handleCompletion(null, ctx, channels)
              throw error
            }
          )
      }

      return send.call(this, command, ...args)
    })
  }
}

function handleCompletion (result, ctx, channels) {
  const iterator = result?.body?.[Symbol.asyncIterator]
  if (!iterator) {
    channels.complete.publish(ctx)
    return
  }

  shimmer.wrap(result.body, Symbol.asyncIterator, function (asyncIterator) {
    return function () {
      const iterator = asyncIterator.apply(this, arguments)
      shimmer.wrap(iterator, 'next', function (next) {
        return function () {
          return next.apply(this, arguments)
            .then(result => {
              const { done, value: chunk } = result
              channels.streamedChunk.publish({ ctx, chunk, done })

              if (done) {
                channels.complete.publish(ctx)
              }

              return result
            })
            .catch(err => {
              addResponse(ctx, err)
              channels.complete.publish(ctx)
              throw err
            })
        }
      })

      return iterator
    }
  })
}

function wrapCb (cb, channels, ctx) {
  // eslint-disable-next-line n/handle-callback-err
  return shimmer.wrapFunction(cb, cb => function wrappedCb (err, response) {
    ctx = { request: ctx.request, response }
    return channels.responseStart.runStores(ctx, () => {
      try {
        let result = cb.apply(this, arguments)
        if (result && result.then) {
          result = result.then(x => {
            channels.responseFinish.publish(ctx)
            return x
          }, e => {
            ctx.error = e
            channels.responseFinish.publish(ctx)
            throw e
          })
        } else {
          channels.responseFinish.publish(ctx)
        }
        return result
      } catch (e) {
        ctx.error = e
        channels.responseFinish.publish(ctx)
        throw e
      }
    })
  })
}

function addResponse (ctx, error, result) {
  const request = ctx.request
  const response = { request, error, ...result }

  if (result && result.$metadata) {
    response.requestId = result.$metadata.requestId
  }

  ctx.response = response
}

function getChannelSuffix (name) {
  // some resource identifiers have spaces between ex: bedrock runtime
  name = String(name).replaceAll(' ', '')
  return KNOWN_CHANNEL_SUFFIXES.has(name) ? name : 'default'
}

addHook({ name: '@smithy/smithy-client', versions: ['>=1.0.3'] }, smithy => {
  shimmer.wrap(smithy.Client.prototype, 'send', wrapSmithySend)
  return smithy
})

addHook({ name: '@aws-sdk/smithy-client', versions: ['>=3'] }, smithy => {
  shimmer.wrap(smithy.Client.prototype, 'send', wrapSmithySend)
  return smithy
})

addHook({ name: 'aws-sdk', versions: ['>=2.3.0'] }, AWS => {
  shimmer.wrap(AWS.config, 'setPromisesDependency', setPromisesDependency => {
    return function wrappedSetPromisesDependency (dep) {
      const result = setPromisesDependency.apply(this, arguments)
      shimmer.wrap(AWS.Request.prototype, 'promise', wrapRequest)
      return result
    }
  })
  return AWS
})

addHook({ name: 'aws-sdk', file: 'lib/core.js', versions: ['>=2.3.0'] }, AWS => {
  shimmer.wrap(AWS.Request.prototype, 'promise', wrapRequest)
  return AWS
})

// <2.1.35 has breaking changes for instrumentation
// https://github.com/aws/aws-sdk-js/pull/629
addHook({ name: 'aws-sdk', file: 'lib/core.js', versions: ['>=2.1.35'] }, AWS => {
  shimmer.wrap(AWS.Request.prototype, 'send', wrapRequest)
  return AWS
})
