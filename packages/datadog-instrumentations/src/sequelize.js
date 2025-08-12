'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')

const shimmer = require('../../datadog-shimmer')

addHook({ name: 'sequelize', versions: ['>=4'] }, Sequelize => {
  const startCh = channel('datadog:sequelize:query:start')
  const finishCh = channel('datadog:sequelize:query:finish')

  shimmer.wrap(Sequelize.prototype, 'query', query => {
    return function (sql, options) {
      if (!startCh.hasSubscribers) {
        return query.apply(this, arguments)
      }

      let dialect
      if (this.options && this.options.dialect) {
        dialect = this.options.dialect
      } else if (this.dialect && this.dialect.name) {
        dialect = this.dialect.name
      }

      function onFinish (result) {
        const type = options?.type || 'RAW'
        if (type === 'RAW' && result?.length > 1) {
          result = result[0]
        }

        finishCh.runStores({ result }, () => {})
      }

      return startCh.runStores({ sql, dialect }, () => {
        const promise = query.apply(this, arguments)
        promise.then(onFinish, () => { onFinish() })

        return promise
      })
    }
  })

  return Sequelize
})
