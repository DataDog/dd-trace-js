#!/usr/bin/env node

const tracer = require('../../')
require('express') // package required after tracer
tracer.init()

process.exit()
