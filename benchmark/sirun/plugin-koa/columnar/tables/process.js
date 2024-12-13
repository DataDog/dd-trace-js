'use strict'

const { Table } = require('../table')
const tracerVersion = require('../../../../../package.json').version
const pkg = require('../../../../../packages/dd-trace/src/pkg')

const service = process.env.SERVICE || pkg.name || 'node'

class ProcessInfoTable extends Table {
  constructor () {
    super({
      tracer_version: Uint16Array,
      language: Uint16Array,
      language_version: Uint16Array,
      language_interpreter: Uint16Array,
      service: Uint16Array
    }, [
      'tracer_version',
      'language',
      'language_version',
      'language_interpreter',
      'service'
    ])
  }

  insert () {
    this.reserve()

    this.columns.tracer_version[this.length] = this._cache('tracer_version', tracerVersion)
    this.columns.language[this.length] = this._cache('language', 'nodejs')
    this.columns.language_version[this.length] = this._cache('language_version', process.version)
    this.columns.language_interpreter[this.length] = this._cache('language_interpreter', process.jsEngine || 'v8')
    this.columns.service[this.length] = this._cache('service', service)

    this.length++
  }
}

module.exports = { ProcessInfoTable }
