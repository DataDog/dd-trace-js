'use strict'

require('../../setup/tap')

const os = require('os')
const {
  getRuntimeAndOSMetadata,
  OS_ARCHITECTURE,
  OS_PLATFORM,
  OS_VERSION,
  RUNTIME_NAME,
  RUNTIME_VERSION
} = require('../../../src/plugins/util/env')

describe('env', () => {
  it('reads runtime and OS metadata', () => {
    const envMetadata = getRuntimeAndOSMetadata()

    expect(envMetadata).to.eql(
      {
        [RUNTIME_VERSION]: process.version,
        [OS_ARCHITECTURE]: process.arch,
        [OS_PLATFORM]: process.platform,
        [RUNTIME_NAME]: 'node',
        [OS_VERSION]: os.release()
      }
    )
  })
})
