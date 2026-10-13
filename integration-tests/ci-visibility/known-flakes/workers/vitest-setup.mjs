import { appendFileSync } from 'node:fs'

import { inject } from 'vitest'

appendFileSync(process.env.WORKER_PAYLOADS_FILE, JSON.stringify({
  workerId: process.env.VITEST_WORKER_ID,
  flakyTests: process.env.DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT === 'true'
    ? inject('_ddVitestWorkerSetup').flakyTests === undefined
      ? undefined
      : { vitest: inject('_ddVitestWorkerSetup').flakyTests }
    : inject('_ddFlakyTests'),
}) + '\n')
