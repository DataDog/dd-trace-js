'use strict'
require('./_runner').run('invoke-amazon-nova').catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
