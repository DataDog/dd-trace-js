export async function register () {
  if (process.env.NEXT_RUNTIME === 'nodejs' && !globalThis[Symbol.for('dd-trace')]) {
    await import('dd-trace/initialize.mjs')
  }
}
