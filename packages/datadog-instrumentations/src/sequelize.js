'use strict'

const {
  channel,
  addHook,
  AsyncResource
} = require('./helpers/instrument')

const shimmer = require('../../datadog-shimmer')

addHook({ name: 'sequelize', versions: ['>=4'] }, Sequelize => {
  const startCh = channel('datadog:sequelize:query:start')
  const finishCh = channel('datadog:sequelize:query:finish')

  shimmer.wrap(Sequelize.prototype, 'query', query => {
    return function (sql) {
      if (!startCh.hasSubscribers) {
        return query.apply(this, arguments)
      }

      const asyncResource = new AsyncResource('bound-anonymous-fn')

      let dialect
      if (this.options && this.options.dialect) {
        dialect = this.options.dialect
      } else if (this.dialect && this.dialect.name) {
        dialect = this.dialect.name
      }

      function onFinish () {
        asyncResource.bind(function () {
          finishCh.publish()
        }, this).apply(this)
      }

      return asyncResource.bind(function () {
        startCh.publish({
          sql,
          dialect
        })

        const promise = query.apply(this, arguments)
        promise.then(onFinish, onFinish)

        return promise
      }, this).apply(this, arguments)
    }
  })

  return Sequelize
})
