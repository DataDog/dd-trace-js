import { appendFileSync } from 'node:fs'

import { inject } from 'vitest'

appendFileSync(process.env.WORKER_PAYLOADS_FILE, JSON.stringify({
  workerId: process.env.VITEST_WORKER_ID,
  flakyTests: inject('_ddFlakyTests'),
}) + '\n')
