'use strict'

const { writeFileSync } = require('fs')
const os = require('os')
const { join } = require('path')

const { setup, testBasicInputWithoutRC } = require('./utils')

describe('Dynamic Instrumentation', function () {
  describe('probe file', function () {
    const probeFile = join(os.tmpdir(), 'probes.json')
    const t = setup({
      testApp: 'target-app/basic.js',
      env: { DD_DYNAMIC_INSTRUMENTATION_PROBE_FILE: probeFile },
      dependencies: ['fastify'],
    })
    const probe = t.generateProbeConfig()
    writeFileSync(probeFile, JSON.stringify([probe]))

    it('should install probes from a probe file', testBasicInputWithoutRC.bind(null, t, probe))
  })
})
