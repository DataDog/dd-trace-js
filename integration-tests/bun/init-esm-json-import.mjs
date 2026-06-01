// Reproduces https://github.com/DataDog/dd-trace-js/issues/7480
// Bun caches JSON imports as read-only ESM module namespaces.
// Importing package.json before dd-trace.init() would crash if pkg.js
// used require() to load the same file and then tried to mutate it.

// JSON must be imported before dd-trace to reproduce the issue.
/* eslint-disable import/order */
import pkg from '../package.json'
import tracer from 'dd-trace'
/* eslint-enable import/order */

tracer.init({ startupLogs: false })

// eslint-disable-next-line no-console
console.log(pkg.name || 'unnamed')
// eslint-disable-next-line no-console
console.log('ok')
process.exit()
