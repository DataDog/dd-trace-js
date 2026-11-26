/**
 * @typedef {{
 *   name: string,
 *   conclusion?: string | null,
 *   started_at?: string | null,
 *   completed_at?: string | null,
 * }} WorkflowStep
 */

/**
 * @typedef {{
 *   name: string,
 *   html_url: string | null,
 *   conclusion?: string | null,
 *   started_at?: string | null,
 *   completed_at?: string | null,
 *   steps?: WorkflowStep[],
 * }} WorkflowJob
 */

/** @typedef {{ id: number, node_id: string, run_attempt?: number }} WorkflowRun */

/**
 * @typedef {{
 *   databaseId?: number,
 *   name: string,
 *   detailsUrl: string | null,
 *   conclusion?: string | null,
 *   startedAt?: string | null,
 *   completedAt?: string | null,
 * }} CheckRun
 */

/**
 * @typedef {{
 *   node?: {
 *     runAttempt: number,
 *     checkSuite: {
 *       checkRuns: {
 *         nodes: CheckRun[],
 *         pageInfo: { hasNextPage: boolean, endCursor?: string | null },
 *       },
 *     },
 *   } | null,
 * }} ChecksResponse
 */

const CHECK_RUNS_QUERY = `
  query WorkflowJobs($id: ID!, $after: String, $filter: CheckRunFilter!, $failedOnly: Boolean!) {
    node(id: $id) {
      ... on WorkflowRun {
        runAttempt
        checkSuite {
          checkRuns(first: 100, after: $after, filterBy: $filter) {
            pageInfo { hasNextPage endCursor }
            nodes {
              databaseId @include(if: $failedOnly)
              name @skip(if: $failedOnly)
              detailsUrl @skip(if: $failedOnly)
              conclusion @skip(if: $failedOnly)
              startedAt @skip(if: $failedOnly)
              completedAt @skip(if: $failedOnly)
            }
          }
        }
      }
    }
  }
`

/**
 * @param {Pick<import('octokit').Octokit, 'graphql'>} api
 * @param {WorkflowRun} run
 * @param {boolean} failedOnly
 * @yields {{ runAttempt: number, nodes: CheckRun[] }} A page of check runs and the latest workflow attempt.
 */
async function * getCheckRunPages (api, run, failedOnly) {
  const attempt = run.run_attempt ?? 1
  let after

  for (;;) {
    /** @type {ChecksResponse} */
    // eslint-disable-next-line no-await-in-loop -- each page requires the preceding cursor
    const response = await api.graphql(CHECK_RUNS_QUERY, {
      id: run.node_id,
      after,
      failedOnly,
      filter: {
        checkType: failedOnly ? 'ALL' : 'LATEST',
        conclusions: failedOnly ? ['FAILURE'] : undefined,
      },
    })
    const node = response.node
    const checks = node?.checkSuite?.checkRuns
    if (!node || !Array.isArray(checks?.nodes)) {
      throw new TypeError(`Unexpected check runs response for workflow run ${run.id}.`)
    }
    if (!Number.isSafeInteger(node.runAttempt) || node.runAttempt < attempt) {
      throw new Error(`Unexpected attempt for workflow run ${run.id}.`)
    }

    yield { runAttempt: node.runAttempt, nodes: checks.nodes }

    if (!checks.pageInfo.hasNextPage) return
    if (!checks.pageInfo.endCursor || checks.pageInfo.endCursor === after) {
      throw new Error(`Missing next check runs page for workflow run ${run.id}.`)
    }
    after = checks.pageInfo.endCursor
  }
}

/**
 * @param {Pick<import('octokit').Octokit, 'graphql' | 'rest'>} api
 * @param {WorkflowRun} run
 * @returns {Promise<WorkflowJob[]>}
 */
export async function getCheckRuns (api, run) {
  const attempt = run.run_attempt ?? 1
  const jobs = []

  for await (const { runAttempt, nodes } of getCheckRunPages(api, run, false)) {
    if (runAttempt > attempt) return getRestJobs(api, run)

    for (const check of nodes) {
      jobs.push({
        name: check.name,
        html_url: check.detailsUrl,
        conclusion: check.conclusion?.toLowerCase(),
        started_at: check.startedAt,
        completed_at: check.completedAt,
      })
    }
  }
  return jobs
}

/**
 * @param {Pick<import('octokit').Octokit, 'graphql'>} api
 * @param {WorkflowRun} run
 * @returns {Promise<number[]>}
 */
export async function getFailedJobIds (api, run) {
  const ids = []

  for await (const { nodes } of getCheckRunPages(api, run, true)) {
    for (const { databaseId } of nodes) {
      if (!Number.isSafeInteger(databaseId)) {
        throw new TypeError(`Missing failed job ID for workflow run ${run.id}.`)
      }
      ids.push(/** @type {number} */ (databaseId))
    }
  }
  return ids
}

/**
 * @param {Pick<import('octokit').Octokit, 'rest'>} api
 * @param {WorkflowRun} run
 * @returns {Promise<WorkflowJob[]>}
 */
export async function getRestJobs (api, run) {
  const perPage = 100
  const jobs = []
  const attempt = run.run_attempt ?? 1
  let expectedTotal

  for (let page = 1; ; page++) {
    // eslint-disable-next-line no-await-in-loop -- the response determines whether another page is needed
    const response = await api.rest.actions.listJobsForWorkflowRunAttempt({
      owner: 'DataDog',
      repo: 'dd-trace-js',
      run_id: run.id,
      attempt_number: attempt,
      per_page: perPage,
      page,
    })

    const batch = response?.data?.jobs
    const total = response?.data?.total_count
    if (!Array.isArray(batch) || !Number.isSafeInteger(total) || total < 0 ||
        (expectedTotal !== undefined && total !== expectedTotal)) {
      throw new TypeError(
        `Unexpected jobs response for workflow run ${run.id}, attempt ${attempt}, ` +
        `page ${page}, per_page ${perPage} (HTTP ${response?.status}).`
      )
    }
    expectedTotal ??= total

    jobs.push(...batch)
    if (jobs.length === total) return jobs
    if (batch.length < perPage || jobs.length > total) {
      throw new Error(
        `Expected ${total} jobs for workflow run ${run.id}, attempt ${attempt}, ` +
        `but received ${jobs.length} by page ${page}.`
      )
    }
  }
}
