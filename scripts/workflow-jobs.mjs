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
 *   id?: number,
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
 *   node?: {
 *     runAttempt: number,
 *     checkSuite: {
 *       checkRuns: {
 *         nodes: Array<{
 *           databaseId?: number,
 *           name: string,
 *           detailsUrl: string,
 *           conclusion?: string | null,
 *           startedAt?: string | null,
 *           completedAt?: string | null,
 *         }>,
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
              name
              detailsUrl
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

const RETRYABLE_STATUSES = new Set([500, 502, 503, 504])

/**
 * @param {Pick<import('octokit').Octokit, 'graphql'>} api
 * @param {WorkflowRun} run
 * @param {boolean} [failedOnly]
 * @returns {Promise<WorkflowJob[]>}
 */
export async function getCheckRuns (api, run, failedOnly = false) {
  const jobs = []
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
    if (node.runAttempt !== (run.run_attempt ?? 1)) {
      throw new Error(`Workflow run ${run.id} was rerun while collecting jobs.`)
    }

    for (const check of checks.nodes) {
      if (failedOnly && !Number.isSafeInteger(check.databaseId)) {
        throw new TypeError(`Missing failed job ID for workflow run ${run.id}.`)
      }
      jobs.push({
        id: check.databaseId,
        name: check.name,
        html_url: check.detailsUrl,
        conclusion: failedOnly ? 'failure' : check.conclusion?.toLowerCase(),
        started_at: check.startedAt,
        completed_at: check.completedAt,
      })
    }

    if (!checks.pageInfo.hasNextPage) return jobs
    if (!checks.pageInfo.endCursor || checks.pageInfo.endCursor === after) {
      throw new Error(`Missing next check runs page for workflow run ${run.id}.`)
    }
    after = checks.pageInfo.endCursor
  }
}

/**
 * @param {Pick<import('octokit').Octokit, 'rest'>} api
 * @param {WorkflowRun} run
 * @returns {Promise<WorkflowJob[]>}
 */
export async function getRestJobs (api, run) {
  let perPage = 100
  for (;;) {
    const jobs = []
    const attempt = run.run_attempt ?? 1

    for (let page = 1; ; page++) {
      let response
      try {
        // eslint-disable-next-line no-await-in-loop -- the response determines whether another page is needed
        response = await api.rest.actions.listJobsForWorkflowRunAttempt({
          owner: 'DataDog',
          repo: 'dd-trace-js',
          run_id: run.id,
          attempt_number: attempt,
          per_page: perPage,
          page,
        })
      } catch (error) {
        if (!RETRYABLE_STATUSES.has(error.status) || perPage === 10) throw error
        break
      }

      const batch = response?.data?.jobs
      if (!Array.isArray(batch)) {
        if (perPage !== 10) break
        throw new TypeError(
          `Unexpected jobs response for workflow run ${run.id}, attempt ${attempt}, ` +
          `page ${page}, per_page ${perPage} (HTTP ${response?.status}).`
        )
      }

      jobs.push(...batch)
      if (batch.length < perPage) return jobs
    }
    // Page boundaries change with per_page; discard earlier pages before retrying.
    perPage = perPage === 100 ? 50 : 10
  }
}
