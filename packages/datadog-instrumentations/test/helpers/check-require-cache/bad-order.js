#!/usr/bin/env node
'use strict'

require('express') // package required before tracer
const tracer = require('../../../../../')
tracer.init()

process.exit()
