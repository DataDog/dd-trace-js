'use strict'

const { storage } = require('../../datadog-core')
const MySQLPlugin = require('../../datadog-plugin-mysql/src')

class MySQL2Plugin extends MySQLPlugin {
  static get id () { return 'mysql2' }

  constructor () {
    super(...arguments)

    this.addSub(`apm:${this.component}:command:add`, ctx => {
      ctx.parentStore = storage('legacy').getStore()
    })

    this.addBind(`apm:${this.component}:command:start`, ctx => ctx.parentStore)
    this.addBind(`apm:${this.component}:command:finish`, ctx => ctx.parentStore)
  }

  bindStart (ctx) {
    return storage('legacy').run(ctx.parentStore, () => super.bindStart(ctx))
  }
}

module.exports = MySQL2Plugin
