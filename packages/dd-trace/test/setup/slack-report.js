/**
 * This allows the test suite to post a Slack channel message when test failures related to packages occur.
 * The intent is to run nightly and proactively discover incompatibilities as new packages are released.
 * The Slack message contains data about the failing package as well as release dates for previous versions.
 * This should help an on-call engineer quickly diagnose when an incompatibility was introduced.
 */

const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK
const SLACK_REPORT_ENABLE = process.env.SLACK_REPORT_ENABLE
const SLACK_MOREINFO = process.env.SLACK_MOREINFO

const VERSION_EXTRACT = /^v?(\d+)\.(\d+)\.(\d+)$/

const FORMATTER = new Intl.RelativeTimeFormat('en-us', { numeric: 'auto' })

const TIME_THRESHOLDS = [
  { threshold: 60, unit: 'seconds' },
  { threshold: 60, unit: 'minutes' },
  { threshold: 24, unit: 'hours' },
  { threshold: 7, unit: 'days' },
  { threshold: 365 / 12 / 7, unit: 'weeks' },
  { threshold: 12, unit: 'months' },
  { threshold: Infinity, unit: 'years' }
]

/**
 * failures: { moduleName: Set(moduleVersion) }
 */
module.exports = async (failures) => {
  if (!SLACK_REPORT_ENABLE) {
    return
  }

  if (!SLACK_WEBHOOK) {
    throw new Error('package reporting via slack webhook is enabled but misconfigured')
  }

  const packageNames = Object.keys(failures)

  const descriptions = []

  for (const packageName of packageNames) {
    const versions = Array.from(failures[packageName])
    const description = await describe(packageName, versions)
    descriptions.push(description)
  }

  let message = descriptions.join('\n\n')

  if (SLACK_MOREINFO) {
    // It's not easy to contextually link to individual job failures.
    // @see https://github.com/community/community/discussions/8945
    // Instead we add a single link at the end to the overall run.
    message += `\n<${SLACK_MOREINFO}|View the failing test(s) here>.`
  }

  reportToSlack(message)
}

async function describe (packageName, versions) {
  const pairs = versions.map((v) => `\`${packageName}@${v}\``).join(' and ')
  let output = `Nightly tests for ${pairs} are failing!\n`

  const suspects = getSuspectedVersions(versions)
  const timestamps = await getVersionData(packageName)

  for (const version of suspects) {
    output += `• version <https://www.npmjs.com/package/${packageName}/v/${version}|${version} ` +
      `was released ${formatTimeAgo(new Date(timestamps[version]))}>.\n`
  }

  return output
}

async function reportToSlack (message) {
  await fetch(SLACK_WEBHOOK, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text: message,
      unfurl_links: false,
      unfurl_media: false
    })
  })
}

async function getVersionData (packageName) {
  const res = await fetch(`https://registry.npmjs.org/${packageName}`)

  const body = await res.json()

  const timestamps = body.time

  return timestamps
}

// TODO: could just to 'semver' package and use .major(), etc, instead of regex
// returns the last three versions of a package that are the most likely to have caused a breaking change
// 1.2.3 -> "1.2.3", "1.2.0", "1.0.0"
// 3.0.0 -> "3.0.0"
function getSuspectedVersions (versions) {
  const result = new Set()

  for (const version of versions) {
    const [, major, minor, patch] = VERSION_EXTRACT.exec(version)

    result.add(`${major}.${minor}.${patch}`)
    result.add(`${major}.${minor}.0`)
    result.add(`${major}.0.0`)
  }

  return Array.from(result)
}

function formatTimeAgo (date) {
  let duration = (date - new Date()) / 1000

  for (const range of TIME_THRESHOLDS) {
    if (Math.abs(duration) < range.threshold) {
      return FORMATTER.format(Math.round(duration), range.unit)
    }
    duration /= range.threshold
  }
}
