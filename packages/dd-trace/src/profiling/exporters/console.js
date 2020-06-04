'use strict'

/* eslint-disable no-console */

const { inspect } = require('util')

class ConsoleExporter {
  constructor (options = {}) {
    this._json = !!options.json
  }

  async export ({ profiles }) {
    this._json
      ? console.log(JSON.stringify(profiles, null, 2))
      : console.log(inspect(profiles, false, Infinity, true))
  }
}

module.exports = { ConsoleExporter }
