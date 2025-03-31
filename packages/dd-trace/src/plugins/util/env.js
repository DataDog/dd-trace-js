const os = require('os')

const OS_PLATFORM = 'os.platform'
const OS_VERSION = 'os.version'
const OS_ARCHITECTURE = 'os.architecture'
const RUNTIME_NAME = 'runtime.name'
const RUNTIME_VERSION = 'runtime.version'
const DD_HOST_CPU_COUNT = '_dd.host.vcpu_count'

function getRuntimeAndOSMetadata () {
  return {
    [RUNTIME_VERSION]: process.version,
    [OS_ARCHITECTURE]: process.arch,
    [OS_PLATFORM]: process.platform,
    [RUNTIME_NAME]: 'node',
    [OS_VERSION]: os.release(),
    [DD_HOST_CPU_COUNT]: os.cpus().length
  }
}

module.exports = {
  getRuntimeAndOSMetadata,
  OS_PLATFORM,
  OS_VERSION,
  OS_ARCHITECTURE,
  RUNTIME_NAME,
  RUNTIME_VERSION,
  DD_HOST_CPU_COUNT
}
