'use strict'
require('./_runner').run('converse-prompt-caching').catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1 })
