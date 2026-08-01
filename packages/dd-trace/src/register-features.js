'use strict'

// This file's require graph is exactly what must stay unreachable from index.electron.js.
require('./openfeature/register')
require('./appsec/register')
require('./appsec/iast/register')
require('./appsec/iast/taint-tracking/register')
