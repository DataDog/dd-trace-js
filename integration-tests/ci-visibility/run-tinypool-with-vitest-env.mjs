import Tinypool from 'tinypool'

const pool = new Tinypool({
  filename: new URL('./tinypool-app/worker.js', import.meta.url).href,
  env: {
    ...process.env,
    VITEST: 'true',
  },
})

const result = await pool.run({ a: 4, b: 6 })
// eslint-disable-next-line no-console
console.log('result', result.sum)
// eslint-disable-next-line no-console
console.log('dd vitest worker', result.ddVitestWorker)

// Make sure to destroy pool once it's not needed anymore
// This terminates all pool's idle workers
await pool.destroy()
