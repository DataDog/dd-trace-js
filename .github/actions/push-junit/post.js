const core = require('@actions/core');
const exec = require('@actions/exec');
const io = require('@actions/io');
const tc = require('@actions/tool-cache');
const cache = require('@actions/cache');
const fs = require('fs');
const path = require('path');
const os = require('os');

async function run() {
  try {
    const version = core.getInput('datadog-ci-version', { required: true }).replace(/^v/, '');
    const site = core.getInput('site') || 'datadoghq.com';
    const pattern = core.getInput('pattern') || '**/*junit.xml';
    const verbose = /^true$/i.test(core.getInput('verbose') || 'true');
    const apiKey = core.getInput('api-key', { required: true });

    // Decide platform/arch + filename
    const plat = process.platform; // 'linux'|'darwin'|'win32'
    const arch = os.arch();        // 'x64'|'arm64'|...
    const osPart = plat === 'linux' ? 'linux'
                 : plat === 'darwin' ? 'darwin'
                 : plat === 'win32' ? 'win'
                 : (() => { core.setFailed(`Unsupported OS: ${plat}`); return null; })();
    if (!osPart) return;

    const archPart = (arch === 'x64' || arch === 'amd64') ? 'x64'
                    : (arch === 'arm64' || arch === 'aarch64') ? 'arm64'
                    : (() => { core.setFailed(`Unsupported arch: ${arch}`); return null; })();
    if (!archPart) return;

    const ext = osPart === 'win' ? '.exe' : '';
    const assetName = `datadog-ci_${osPart}-${archPart}${ext}`;
    const url = `https://github.com/DataDog/datadog-ci/releases/download/v${version}/${assetName}`;

    // Local bin dir we control & can cache
    const binDir = path.join(process.env.GITHUB_WORKSPACE || process.cwd(), '.datadog', 'bin');
    const binPath = path.join(binDir, `datadog-ci${ext}`);
    await io.mkdirP(binDir);

    // Cache key
    const cacheKey = `datadog-ci-${osPart}-${archPart}-${version}`;
    const restoreKey = `datadog-ci-${osPart}-`;

    // Try restore cache
    let cacheHit = false;
    try {
      const restored = await cache.restoreCache([binDir], cacheKey, [restoreKey]);
      cacheHit = !!restored && fs.existsSync(binPath);
    } catch (e) {
      core.info(`Cache restore skipped: ${e.message}`);
    }

    if (!cacheHit) {
      core.info(`Downloading ${url}`);
      const dl = await tc.downloadTool(url);
      await io.mv(dl, binPath);
      try { fs.chmodSync(binPath, 0o755); } catch (_) {} // Windows-safe
      try {
        await cache.saveCache([binDir], cacheKey);
      } catch (e) {
        if (!/already exists/i.test(String(e.message || e))) throw e;
        core.info(`Cache already exists for key ${cacheKey}`);
      }
    } else {
      core.info(`Using cached datadog-ci at ${binPath}`);
    }

    core.addPath(binDir);

    // Sanity check
    await exec.exec(binPath, ['--version']);

    // Build args & env
    const args = ['junit', 'upload', pattern];
    if (verbose) args.push('--verbose');

    const env = {
      ...process.env,
      DD_API_KEY: apiKey,
      DD_SITE: site
    };

    // Run upload
    core.startGroup('Uploading JUnit reports to Datadog');
    const code = await exec.exec(binPath, args, { env, ignoreReturnCode: true });
    core.endGroup();

    if (code !== 0) {
      core.setFailed(`datadog-ci exited with code ${code}`);
    }
  } catch (err) {
    core.setFailed(err instanceof Error ? err.message : String(err));
  }
}

run();
