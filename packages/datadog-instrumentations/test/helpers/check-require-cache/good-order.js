#!/usr/bin/env node
'use strict'

const tracer = require('../../../../../')
require('express') // package required after tracer
tracer.init()

process.exit()
