'use strict'

require('../../').init() // dd-trace

// this should be bundled
require('axios')

// this is in the external list and should not be bundled
require('knex')
