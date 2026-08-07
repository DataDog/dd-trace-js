'use strict'

require('./src/openfeature/register')
require('./src/appsec/register')
require('./src/appsec/iast/register')
require('./src/appsec/iast/taint-tracking/register')
module.exports = require('./src/bootstrap')
