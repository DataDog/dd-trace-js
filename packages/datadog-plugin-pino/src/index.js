'use strict'

const { LOG } = require('../../../ext/formats')

function createWrapPino (tracer, config, symbol, wrapper) {
  return function wrapPino (pino) {
    return function pinoWithTrace () {
      const instance = pino.apply(this, arguments)

      Object.defineProperty(instance, symbol, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: wrapper(tracer, config)(instance[symbol])
      })

      return instance
    }
  }
}

function createWrapAsJson (tracer, config) {
  return function wrapAsJson (asJson) {
    return function asJsonWithTrace (obj, msg, num, time) {
      const span = tracer.scope().active()

      obj = arguments[0] = obj || {}

      tracer.inject(span, LOG, obj)

      const json = asJson.apply(this, arguments)

      obj && delete obj.dd

      return json
    }
  }
}

function createWrapMixin (tracer, config) {
  return function wrapMixin (mixin) {
    return function mixinWithTrace () {
      let obj = {}

      if (mixin) {
        obj = mixin.apply(this, arguments)
      }

      const span = tracer.scope().active()

      tracer.inject(span, LOG, obj)

      return obj
    }
  }
}

function createWrapPrettifyObject (tracer, config) {
  return function wrapPrettifyObject (prettifyObject) {
    return function prettifyObjectWithTrace (input) {
      const span = tracer.scope().active()

      tracer.inject(span, LOG, input.input)

      return prettifyObject.apply(this, arguments)
    }
  }
}

function createWrapPrettyFactory (tracer, config) {
  return function wrapPrettyFactory (prettyFactory) {
    return function prettyFactoryWithTrace () {
      const pretty = prettyFactory.apply(this, arguments)

      return function prettyWithTrace (obj) {
        const span = tracer.scope().active()

        tracer.inject(span, LOG, obj)

        return pretty.apply(this, arguments)
      }
    }
  }
}

module.exports = [
  {
    name: 'pino',
    versions: ['2 - 3', '4', '>=5 <5.14.0'],
    patch (pino, tracer, config) {
      if (!tracer._logInjection) return

      const asJsonSym = (pino.symbols && pino.symbols.asJsonSym) || 'asJson'

      return this.wrapExport(pino, createWrapPino(tracer, config, asJsonSym, createWrapAsJson)(pino))
    },
    unpatch (pino) {
      return this.unwrapExport(pino)
    }
  },
  {
    name: 'pino',
    versions: ['>=5.14.0 <6.8.0'],
    patch (pino, tracer, config) {
      if (!tracer._logInjection) return

      const mixinSym = pino.symbols.mixinSym

      return this.wrapExport(pino, createWrapPino(tracer, config, mixinSym, createWrapMixin)(pino))
    },
    unpatch (pino) {
      return this.unwrapExport(pino)
    }
  },
  {
    name: 'pino',
    versions: ['>=6.8.0'],
    patch (pino, tracer, config) {
      if (!tracer._logInjection) return

      const mixinSym = pino.symbols.mixinSym

      const wrapped = this.wrapExport(pino, createWrapPino(tracer, config, mixinSym, createWrapMixin)(pino))

      wrapped.pino = this.wrapExport(pino.pino, createWrapPino(tracer, config, mixinSym, createWrapMixin)(pino.pino))
      wrapped.default = this.wrapExport(pino.default,
        createWrapPino(tracer, config, mixinSym, createWrapMixin)(pino.default))

      return wrapped
    },
    unpatch (pino) {
      const unwrapped = this.unwrapExport(pino)
      unwrapped.pino = this.unwrapExport(pino.pino)
      unwrapped.default = this.unwrapExport(pino.default)

      return unwrapped
    }
  },
  {
    name: 'pino-pretty',
    versions: ['>=3'], // will only work starting from pino@5.0.0 as previous versions are not using pino-pretty
    file: 'lib/utils.js',
    patch (utils, tracer, config) {
      if (!tracer._logInjection) return

      this.wrap(utils, 'prettifyObject', createWrapPrettifyObject(tracer, config))
    },
    unpatch (utils) {
      this.unwrap(utils, 'prettifyObject')
    }
  },
  {
    name: 'pino-pretty',
    versions: ['1 - 2'],
    patch (prettyFactory, tracer, config) {
      if (!tracer._logInjection) return

      return this.wrapExport(prettyFactory, createWrapPrettyFactory(tracer, config)(prettyFactory))
    },
    unpatch (prettyFactory) {
      return this.unwrapExport(prettyFactory)
    }
  }
]
