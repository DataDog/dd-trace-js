'use strict'

const shimmer = require('../../datadog-shimmer')
const { addHook, channel } = require('./helpers/instrument')
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
        isURL: false,
      })

      return parsedValue
    }
  })

  const URLPrototype = url.URL.prototype.constructor.prototype
  // Store the original property descriptors before shimmer modifies them
  // This is needed because getters that access private fields (like #context in URL)
  // cannot be called via .call() - we need to keep a reference to the original getter
  const originalDescriptors = {}
  for (const property of instrumentedGetters) {
    originalDescriptors[property] = Object.getOwnPropertyDescriptor(URLPrototype, property)
  }
  for (const property of instrumentedGetters) {
    const originalDescriptor = originalDescriptors[property]
    if (!originalDescriptor || !originalDescriptor.get) continue
    shimmer.wrap(URLPrototype, property, function () {
      return function get () {
        // Use the original descriptor's getter to preserve private field access
        const result = originalDescriptor.get.call(this)
        if (!urlGetterChannel.hasSubscribers) return result

        const context = { urlObject: this, result, property }
        urlGetterChannel.publish(context)

        return context.result
      }
    })
  }

  shimmer.wrap(url, 'URL', (URL) => {
    return class extends URL {
      constructor (input, base) {
        super(...arguments)

        if (!parseFinishedChannel.hasSubscribers) return

        parseFinishedChannel.publish({
          input,
          base,
          parsed: this,
          isURL: true,
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
          isURL: true,
        })

        return parsedValue
      }
    })
  }
})
