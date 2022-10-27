'use strict'

const StoragePlugin = require('./storage')

class DatabasePlugin extends StoragePlugin {
  static get operation () { return 'query' }

  createSQLInjectionComment = () =>  {

    const dddbs = encodeURIComponent(this.config.service)
    const dde = encodeURIComponent(this.tracer._env)
    const ddps = encodeURIComponent(this.tracer._service)
    const ddpv = encodeURIComponent(this.tracer._version)
  
    return `/*dddbs='${dddbs}',dde='${dde}',ddps='${ddps}',ddpv='${ddpv}'*/ `
  
  }
}

module.exports = DatabasePlugin
