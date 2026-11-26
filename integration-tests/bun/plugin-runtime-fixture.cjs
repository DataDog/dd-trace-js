'use strict'

process.stdout.write('stdout works\n')
process.stderr.write('stderr works\n')
process.send({ bun: process.versions.bun })
process.once('message', message => {
  process.send(message, () => process.disconnect())
})
