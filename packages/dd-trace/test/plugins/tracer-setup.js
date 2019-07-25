'use strict'

const execSync = require('child_process').execSync
const color = require('../../../../scripts/helpers/color')

const options = { stdio: [0, 1, 2] }
execSync(`echo "${color.GRAY}# Injecting tracer ${color.NONE}"`, options)

// Require the tracer before running any external tests
require('../../../dd-trace').init()
