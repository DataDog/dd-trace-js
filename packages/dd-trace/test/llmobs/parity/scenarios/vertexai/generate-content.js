'use strict'
require('./_runner').run('generate-content').catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
