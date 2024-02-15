'use strict'

const { channel, addHook } = require('./helpers/instrument')

const shimmer = require('../../datadog-shimmer')

addHook({ name: 'lodash', versions: ['>=4'] }, lodash => {

  const trimCh = channel('datadog:lodash:trim')
  const trimEndCh = channel('datadog:lodash:trimEnd')

  shimmer.wrap(lodash, 'trim', trim => {
    return function (string, chars, guard) {
      if (!trimCh.hasSubscribers) {
        return trim(arguments)
      }

      const result = trim(...arguments)
      trimCh.publish({arguments, result})

      return result
    }
  })

  shimmer.wrap(lodash, 'trimStart', trimStart => {
    return function (string, chars, guard) {
      if (!trimCh.hasSubscribers) {
        return trimStart(...arguments)
      }

      const result = trimStart(...arguments)
      trimCh.publish({arguments, result})

      return result
    }
  })

  shimmer.wrap(lodash, 'trimEnd', trimEnd => {
    return function (string, chars, guard) {
      if (!trimEndCh.hasSubscribers) {
        return trimEnd(...arguments)
      }

      const result = trimEnd(...arguments)
      trimEndCh.publish({arguments, result})

      return result
    }
  })

  return lodash
})
