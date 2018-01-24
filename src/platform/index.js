'use strict'

var assign = require('lodash.assign')

module.exports = {
  use: function (impl) {
    assign(this, impl)
  }
}
