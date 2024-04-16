'use strict'

const { channel, addHook } = require('./helpers/instrument')

const shimmer = require('../../datadog-shimmer')

addHook({ name: 'lodash', versions: ['>=4'] }, lodash => {
  const lodashOperationCh = channel('datadog:lodash:operation')

  const instrumentedLodashFn = ['trim', 'trimStart', 'trimEnd', 'toLower', 'toUpper', 'join']

  shimmer.massWrap(
    lodash,
    instrumentedLodashFn,
    lodashFn => {
      return function () {
        if (!lodashOperationCh.hasSubscribers) {
          return lodashFn.apply(this, arguments)
        }

        const result = lodashFn.apply(this, arguments)
        lodashOperationCh.publish({ operation: lodashFn.name, arguments, result })

        return result
      }
    }
  )

  return lodash
})
