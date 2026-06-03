'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

addHook({ name: 'lodash', versions: ['>=4'] }, lodash => {
  const lodashOperationCh = channel('datadog:lodash:operation')

  const instrumentedLodashFn = ['trim', 'trimStart', 'trimEnd', 'toLower', 'toUpper', 'join']

  shimmer.massWrap(
    lodash,
    instrumentedLodashFn,
    lodashFn => {
      return function (...args) {
        if (!lodashOperationCh.hasSubscribers) {
          return lodashFn.apply(this, args)
        }

        const result = lodashFn.apply(this, args)
        const message = { operation: lodashFn.name, arguments: args, result }
        lodashOperationCh.publish(message)

        return message.result
      }
    }
  )

  return lodash
})
