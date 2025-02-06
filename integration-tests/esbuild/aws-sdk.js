'use strict'

require('../../').init() // dd-trace

const aws = require('aws-sdk')

global.test = aws.util.inherit
