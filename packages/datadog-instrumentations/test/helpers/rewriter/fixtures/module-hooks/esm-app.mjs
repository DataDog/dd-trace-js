import dc from 'dc-polyfill'

/** @type {string[]} */
const rewrites = []
dc.channel('dd-trace:instrumentation:load:orchestrion').subscribe(({ moduleName, result }) => {
  if (moduleName === 'bullmq') rewrites.push(result)
})

// A CommonJS target imported from an ES module.
await import('bullmq')

process.stdout.write(JSON.stringify({ commonjs: rewrites }))
