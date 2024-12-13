'use strict'
const Stepfunctions = require('./stepfunctions')
class States extends Stepfunctions {
  static get id () { return 'states' }
}

module.exports = States
