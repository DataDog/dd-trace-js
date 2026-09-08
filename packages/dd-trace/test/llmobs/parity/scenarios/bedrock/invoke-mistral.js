'use strict'
require('./_runner').run('invoke-mistral').catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
