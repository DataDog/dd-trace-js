'use strict'

require('../../..')
const ExposuresWriter = require('../../../packages/dd-trace/src/openfeature/writers/exposures')

const [url, count, applicationMs] = process.argv.slice(2)
const writer = new ExposuresWriter({ url: new URL(url), service: 'shutdown-test' })
writer.setEnabled(true)
const start = Date.now()
let beforeExitMs
process.once('beforeExit', () => { beforeExitMs = Date.now() - start })
process.once('exit', () => {
  const result = { beforeExitMs, elapsedMs: Date.now() - start, dropped: writer.droppedEventCount }
  process.stdout.write(JSON.stringify(result))
})
for (let i = 0; i < Number(count); i++) {
  writer.append({ subject: { id: String(i) }, flag: { key: 'flag' }, variant: { key: 'A' } })
  writer.flush()
}
if (Number(applicationMs)) setTimeout(() => {}, Number(applicationMs))
