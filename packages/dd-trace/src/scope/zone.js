'use strict'

// TODO: Zone metrics

const Base = require('./base')
const Zone = require('zone.js/dist/zone') && window.Zone

let singleton = null

class Scope extends Base {
  constructor () {
    if (singleton) return singleton

    super()

    singleton = this
  }

  _active () {
    return Zone.current.get('_datadog_span')
  }

  _activate (span, callback) {
    const spec = {
      properties: {
        _datadog_span: span
      }
    }

    return Zone.current.fork(spec).run(() => callback())
  }
}

module.exports = Scope
