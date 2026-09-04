try {
  // Vitest does not expose setFn from its public setup API; keep this optional for strict installers.
  const vitestRunner = await import('@vitest/runner')
  globalThis[Symbol.for('dd-trace.vitest.set-fn')] = vitestRunner.setFn
} catch {}
globalThis[Symbol.for('dd-trace.vitest.browser-context-importer')] = () => import('@vitest/browser/context')

await import('./vitest-no-worker-init-setup.mjs')
