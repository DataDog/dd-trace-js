import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
require('postgres')
throw new Error('application error')
