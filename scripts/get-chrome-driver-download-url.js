/* eslint n/no-unsupported-features/node-builtins: ['error', { version: '>=21.0.0', allowExperimental: true }] */

const URL = 'https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json'

// Get chrome driver download URL from a given chrome version, provided via CHROME_VERSION env var
async function getChromeDriverDownloadURL (chromePlatform = 'linux64') {
  // CHROME_VERSION is the output of google-chrome --version, e.g. "Google Chrome 124.0.6367.60"
  const chromeVersion = process.env.CHROME_VERSION

  const majorMinorPatch = chromeVersion.split(' ')[2].split('.').slice(0, 3).join('.').trim()
  const res = await fetch(URL)
  const json = await res.json()

  const versions = json.versions.filter(({ version }) => version.includes(majorMinorPatch))

  const latest = versions[versions.length - 1]

  // eslint-disable-next-line
  console.log(latest.downloads.chromedriver.find(({ platform }) => platform === chromePlatform).url)
}

getChromeDriverDownloadURL(process.env.CHROME_PLATFORM)
