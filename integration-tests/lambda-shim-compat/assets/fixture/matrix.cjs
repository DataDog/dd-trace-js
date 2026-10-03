'use strict'

const full = [
  'sync', 'promise', 'throw', 'reject', 'callback', 'callback-error', 'done', 'succeed', 'fail',
  'artifact', 'race-callback', 'race-promise', 'stream', 'stream-throw', 'stream-reject',
  'timeout-promise', 'timeout-callback', 'timeout-context', 'warm-reject', 'repeat-wrap',
  'metrics-only', 'disabled-instrumentation', 'timeout-plugin-disabled', 'custom-config', 'propagation',
  'frozen-handler', 'timeout-frozen',
]
const shorter = ['promise', 'callback', 'stream', 'stream-throw', 'timeout-promise', 'timeout-callback',
  'metrics-only', 'custom-config', 'frozen-handler', 'timeout-frozen']
const entries = ['npm', 'redirect-cjs', 'redirect-esm', 'layer-cjs', 'layer-esm']

function select (mode, filter = '') {
  if (!['normal', 'layer-only', 'preload'].includes(mode)) throw new Error(`Unknown mode: ${mode}`)
  return entries.flatMap(entry => {
    if (mode === 'layer-only' && !entry.startsWith('layer')) return []
    const scenarios = mode === 'preload'
      ? ['timeout-promise']
      : entry === 'npm' || entry === 'redirect-cjs' ? full : shorter
    return scenarios.map(scenario => ({ entry, scenario }))
  }).filter(({ entry, scenario }) => `${entry}/${scenario}`.includes(filter))
}

module.exports = { select }
