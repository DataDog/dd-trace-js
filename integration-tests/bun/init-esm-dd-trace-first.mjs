import tracer from 'dd-trace'
import pkg from '../package.json'

tracer.init({ startupLogs: false })

// eslint-disable-next-line no-console
console.log(pkg.name || 'unnamed')
// eslint-disable-next-line no-console
console.log('ok')
process.exit()
