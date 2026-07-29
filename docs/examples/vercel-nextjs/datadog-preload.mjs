import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let ddTraceInstalled = true

try {
  require.resolve('dd-trace')
} catch (error) {
  if (error?.code !== 'MODULE_NOT_FOUND') throw error
  ddTraceInstalled = false
}

// Vercel also applies NODE_OPTIONS while installing dependencies, before
// dd-trace exists. Do not suppress errors after the package becomes available.
if (ddTraceInstalled) {
  await import('dd-trace/initialize.mjs')
}
