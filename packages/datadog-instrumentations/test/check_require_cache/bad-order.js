#!/usr/bin/env node

require('express') // package required before tracer
const tracer = require('../../')
tracer.init()

process.exit()
