import Tinypool from 'tinypool'

const pool = new Tinypool({
  filename: new URL('./tinypool-worker.mjs', import.meta.url).href,
})

const result = await pool.run({ a: 4, b: 6 })
// eslint-disable-next-line no-console
console.log('result', result)

// Make sure to destroy pool once it's not needed anymore
// This terminates all pool's idle workers
await pool.destroy()
