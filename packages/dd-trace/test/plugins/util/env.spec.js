'use strict'

const t = require('tap')
require('../../setup/core')

const os = require('os')
const {
  getRuntimeAndOSMetadata,
  OS_ARCHITECTURE,
  OS_PLATFORM,
  OS_VERSION,
  RUNTIME_NAME,
  RUNTIME_VERSION,
  DD_HOST_CPU_COUNT
} = require('../../../src/plugins/util/env')

t.test('env', t => {
  t.test('reads runtime and OS metadata', t => {
    const envMetadata = getRuntimeAndOSMetadata()

    expect(envMetadata).to.eql(
      {
        [RUNTIME_VERSION]: process.version,
        [OS_ARCHITECTURE]: process.arch,
        [OS_PLATFORM]: process.platform,
        [RUNTIME_NAME]: 'node',
        [OS_VERSION]: os.release(),
        [DD_HOST_CPU_COUNT]: os.cpus().length
      }
    )
    t.end()
  })
  t.end()
})
