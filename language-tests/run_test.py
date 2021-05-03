import dataclasses
import http.client
import os
import subprocess
import re
import sys
import time
from dataclasses import dataclass
from itertools import groupby
from operator import itemgetter
from pathlib import Path

NODE_BIN = Path(os.environ.get("NODE_BIN", "/usr/bin/node")).expanduser()
NODE_PROJECT_PATH = Path(os.environ["NODE_PROJECT"]).expanduser()

NEEDS_TO_SPAWN_AGENT = False

MODULES = [
    "dns",
    "fs",
    "tcp",
    "http",
    "http2",
    "net",
]

# Taken from nodeJS repo.
# These are not run by default on their CI because they require special setups
IGNORED_SUITES = [
    "addons",
    "benchmark",
    "doctool",
    "embedding",
    "internet",
    "js-native-api",
    "node-api",
    "pummel",
    "tick-processor",
    "v8-updates",
]

UNEXPECTED_FAILURES = [
    "test/parallel/test-dns-lookup-promises.js",
    "test/parallel/test-dns-lookup.js",
    "test/parallel/test-dns-lookupService.js",
    "test/async-hooks/test-http-agent-handle-reuse-parallel.js",
    "test/async-hooks/test-http-agent-handle-reuse-serial.js",
    "test/parallel/test-http-client-check-http-token.js",
    "test/parallel/test-http-invalid-urls.js",
    "test/parallel/test-http-max-headers-count.js",
    "test/parallel/test-http-parser-lazy-loaded.js",
    "test/sequential/test-http2-timeout-large-write-file.js",
    "test/parallel/test-net-connect-call-socket-connect.js",
    "test/parallel/test-http2-padding-aligned.js",
    "test/parallel/test-http-same-map.js",
    "test/parallel/test-http-deprecated-urls.js",
    "test/parallel/test-fs-access.js",
    "test/parallel/test-fs-chmod.js",
    "test/parallel/test-fs-chown-type-check.js",
    "test/parallel/test-fs-close-errors.js",
    "test/parallel/test-fs-copyfile.js",
    "test/parallel/test-fs-error-messages.js",
    "test/parallel/test-fs-fchmod.js",
    "test/parallel/test-fs-fchown.js",
    "test/parallel/test-fs-fsync.js",
    "test/parallel/test-fs-lchmod.js",
    "test/parallel/test-fs-lchown.js",
    "test/parallel/test-fs-make-callback.js",
    "test/parallel/test-fs-makeStatsCallback.js",
    "test/parallel/test-fs-open.js",
    "test/parallel/test-fs-opendir.js",
    "test/parallel/test-fs-read.js",
    "test/parallel/test-fs-realpath-native.js",
    "test/parallel/test-fs-realpath.js",
    "test/parallel/test-fs-stat.js",
    "test/parallel/test-fs-truncate.js",
]

# These tests trigger a stackoverflow in the test agent because
# traces are too deep
TEST_AGENT_IGNORE = [
    "test/parallel/test-http-pipeline-requests-connection-leak.js",
    "test/parallel/test-http2-forget-closed-streams.js",
]


def list_js_tests(node_path: Path):
    tests = [
        (path.stem.split("-")[1], path)
        for path in node_path.glob("test/**/test-*.js")
        if should_run_test(path)
    ]
    return tests


def should_run_test(test_path: Path):
    return (
        is_in_testsuite(test_path)
        and test_path.stem.split("-")[1] in MODULES
        and test_path.parent.name not in IGNORED_SUITES
    )


def is_in_testsuite(test_path: Path):
    return (test_path.parent / "testcfg.py").exists()


def start_agent_test(test_identifier):
    conn = http.client.HTTPConnection("127.0.0.1", 8126)
    conn.request("GET", f"/test/start?token={test_identifier}", {}, {})
    # Can't check the response because connection is closed immediatly
    # which is not handled by the http lib


def get_agent_test_result(test_identifier):
    conn = http.client.HTTPConnection("127.0.0.1", 8126)
    conn.request("GET", f"/test/check?token={test_identifier}", {}, {})
    res = conn.getresponse()
    return res.status, res.read().decode("utf-8")


@dataclass
class TestResult:
    test_file: Path
    rc: int
    stderr: str
    test_agent_code: int
    test_agent_res: str
    is_pass: bool = dataclasses.field(init=False)
    is_ignore: bool = dataclasses.field(init=False)

    def is_agent_ignore(self):
        return (
            any(
                self.test_file.samefile(NODE_PROJECT_PATH / ignored)
                for ignored in TEST_AGENT_IGNORE
            )
            or "No traces found for token" in self.test_agent_res
        )

    def is_error_ignore(self):
        return (
            self.test_file.parent.name == "known_issues"
            or any(
                self.test_file.samefile(NODE_PROJECT_PATH / ignored)
                for ignored in UNEXPECTED_FAILURES
            )
            or self.is_header_diff()
        )

    def is_header_diff(self):
        tracing_headers = (
            "x-datadog-trace-id",
            "x-datadog-parent-id",
            "x-datadog-sampled",
        )
        return any((header in self.stderr for header in tracing_headers))

    def __post_init__(self):
        self.is_pass = self.rc == 0 and (
            self.test_agent_code == 200 or self.is_agent_ignore()
        )
        self.is_ignore = self.is_error_ignore()

    def error_message(self):
        message = []
        message.append(f"Test agent reponse code {self.test_agent_code}\n")
        for line in self.test_agent_res.splitlines():
            message.append(f"|    {line}\n")
        message.append(f"Test output: rc {self.rc}\n")
        for line in self.stderr.splitlines():
            message.append(f"|    {line}\n")
        return "".join(message)


def start_docker_agent():
    cmd = [
        "docker",
        "run",
        "-d",
        "--rm",
        "--name",
        "dd-test-agent",
        "-p",
        "8126:8126",
        "kyleverhoog/dd-trace-test-agent:latest",
    ]
    output = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
    )
    assert output.returncode == 0, output.stderr


def stop_docker_agent():
    cmd = ["docker", "stop", "dd-test-agent"]
    output = subprocess.run(
        cmd,
        capture_output=True,
    )
    assert output.returncode == 0, output.stderr


VERSION_RE = re.compile(r"v(\d+)(\.[a-z0-9]+){0,2}")


def node_version(node_bin):
    version_output = subprocess.run([node_bin, "-v"], capture_output=True, text=True)
    assert version_output.returncode == 0, version_output.stderr
    version = str(version_output.stdout).strip()
    assert (match := VERSION_RE.fullmatch(version)), version_output.stdout
    return version, match.group(1)


def node_project_version(project_path):
    version_output = subprocess.run(
        ["git", "branch", "--show-current"],
        capture_output=True,
        text=True,
        cwd=project_path,
    )
    assert version_output.returncode == 0, version_output.stderr
    version = str(version_output.stdout).strip()
    assert (match := VERSION_RE.fullmatch(version)), version_output.stdout
    return version, match.group(1)


FLAGS_RE = re.compile(r"//\s+Flags:(.*)")


def find_flags(test_path):
    flags = []
    with open(test_path, "r") as f:
        for line in f:
            if (match := FLAGS_RE.match(line.strip())) is None:
                continue
            flags.extend(match.group(1).strip().split())
    return flags


def run_test(project_path, test_case_path, node_bin):
    flags = find_flags(test_case_path)
    cmd = [
        node_bin,
        *flags,
        "--require",
        Path(__file__).parents[1] / "init.js",
        test_case_path,
    ]
    test_result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        cwd=project_path,
    )
    return (test_result.returncode, test_result.stderr, cmd)


def run_module_tests(name, tests):
    print(f'Running {len(tests)} tests for module "{name}"')
    results = []
    for test in tests:
        start_agent_test(test.stem)

        rc, stderr, cmd = run_test(NODE_PROJECT_PATH, test, NODE_BIN)
        code, response = get_agent_test_result(test.stem)

        results.append(TestResult(test, rc, stderr, code, response))

    failed = [r for r in results if not r.is_pass and not r.is_ignore]
    ignored = [r for r in results if not r.is_pass and r.is_ignore]

    print(
        f"Failed {len(failed)}/{len(results)} tests, {len(ignored)}/{len(results)} ignored"
    )
    if len(failed) > 0:
        print(f"Failed tests:")

        for r in failed:
            print(r.test_file)
            print(r.error_message())
            print("")
    return results


if __name__ == "__main__":
    try:
        version, major = node_version(NODE_BIN)
        print(f"Running tests for node {version}")
        assert (
            major == node_project_version(NODE_PROJECT_PATH)[1]
        ), "The Node repo isn't at the same version  as the binary"
        if NEEDS_TO_SPAWN_AGENT:
            print("Starting docker agent")
            start_docker_agent()
            # Wait for the agent to be up
            time.sleep(5)

        tests = list_js_tests(NODE_PROJECT_PATH)

        tests.sort()
        tests_by_module = {
            key: [path for _, path in group]
            for key, group in groupby(tests, itemgetter(0))
        }

        print("Running following tests:")
        for module, tests in tests_by_module.items():
            print(f"\t{module} : {len(tests)} tests")

        results = []
        for key, tests in tests_by_module.items():
            results.extend(run_module_tests(key, tests))

        should_fail = any((not r.is_pass and not r.is_ignore for r in results))
        sys.exit(1 if should_fail else 0)

    finally:
        try:
            if NEEDS_TO_SPAWN_AGENT:
                print("Stopping the docker agent")
                stop_docker_agent()
        except Exception as e:
            print(f"Failed to stop the docker agent: {e}")
            pass
