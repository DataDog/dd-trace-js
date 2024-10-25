'use strict'
const Stepfunctions = require('./stepfunctions')
class Sfn extends Stepfunctions {
  static get id () { return 'sfn' }
}

module.exports = Sfn
