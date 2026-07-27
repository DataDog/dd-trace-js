import { resolve } from 'dd-trace/loader-hook.mjs'

process.stdout.write(`${resolve === undefined}\n`)
