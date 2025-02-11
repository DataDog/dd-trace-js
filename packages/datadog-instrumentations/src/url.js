'use strict'

const { addHook, channel } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const names = ['url', 'node:url']

const parseFinishedChannel = channel('datadog:url:parse:finish')
const urlGetterChannel = channel('datadog:url:getter:finish')
const instrumentedGetters = ['host', 'origin', 'hostname']

addHook({ name: names }, function (url) {
  shimmer.wrap(url, 'parse', (parse) => {
    return function wrappedParse (input) {
      const parsedValue = parse.apply(this, arguments)
      if (!parseFinishedChannel.hasSubscribers) return parsedValue

      parseFinishedChannel.publish({
        input,
        parsed: parsedValue,
        isURL: false
      })

      return parsedValue
    }
  })

  const URLPrototype = url.URL.prototype.constructor.prototype
  instrumentedGetters.forEach(property => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(URLPrototype, property)

    if (originalDescriptor?.get) {
      const newDescriptor = shimmer.wrap(originalDescriptor, 'get', function (originalGet) {
        return function get () {
          const result = originalGet.apply(this, arguments)
          if (!urlGetterChannel.hasSubscribers) return result

          const context = { urlObject: this, result, property }
          urlGetterChannel.publish(context)

          return context.result
        }
      })

      Object.defineProperty(URLPrototype, property, newDescriptor)
    }
  })

  shimmer.wrap(url, 'URL', (URL) => {
    return class extends URL {
      constructor (input, base) {
        super(...arguments)

        if (!parseFinishedChannel.hasSubscribers) return

        parseFinishedChannel.publish({
          input,
          base,
          parsed: this,
          isURL: true
        })
      }

      static [Symbol.hasInstance] (instance) {
        return instance instanceof URL
      }
    }
  })

  if (url.URL.parse) {
    shimmer.wrap(url.URL, 'parse', (parse) => {
      return function wrappedParse (input, base) {
        const parsedValue = parse.apply(this, arguments)
        if (!parseFinishedChannel.hasSubscribers) return parsedValue

        parseFinishedChannel.publish({
          input,
          base,
          parsed: parsedValue,
          isURL: true
        })

        return parsedValue
      }
    })
  }

  return url
})
