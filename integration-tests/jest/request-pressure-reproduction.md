# Jest sequential `runCLI` request-pressure reproduction

This manual integration scenario tests whether sequential short Jest runs can create concurrent
`/api/v2/citestcycle` requests within one process. It deliberately creates enough test metadata to cross the Test
Optimization encoder's payload-size threshold several times per run, then delays each local intake response.

The client-side output reports:

- `attempts`: test-cycle HTTP requests created by the tracer;
- `maxActiveSockets`: sockets active for the intake origin;
- `maxQueuedRequests`: requests waiting in the Node.js agent for that origin;
- `maxSocketWaitMs`: longest delay between creating a request and assigning its socket;
- `errors`: errors observed by those HTTP requests.

The intake output reports how many requests actually reached the server. With `maxSockets: 1`,
`maxActiveSockets` should remain 1 while `maxQueuedRequests` becomes greater than 0. This demonstrates that one
Jest process can create same-origin concurrency even though its `runCLI` calls are sequential.

Run the same harness from checkouts of v6.1.0 and v6.11.0, keeping Jest and all `DD_REPRO_*` values fixed:

```sh
JEST_VERSION=30.0.5 \
  ./node_modules/.bin/mocha --timeout 120000 integration-tests/jest/jest.request-pressure.repro.js
```

The scenario defaults to two runs, 2,000 tests per run, 6,000 bytes in each test name, and a three-second intake
response delay. Long test names provide a stable payload source that both tracer versions capture. These values can
be adjusted without changing the fixture:

```sh
DD_REPRO_RUN_COUNT=3 \
DD_REPRO_TEST_COUNT=2500 \
DD_REPRO_PARAMETER_BYTES=6000 \
DD_REPRO_RESPONSE_DELAY_MS=3000 \
DD_REPRO_FINAL_TIMEOUT_MS=165000 \
DD_REPRO_TIMEOUT_MS=180000 \
JEST_VERSION=30.0.5 \
  ./node_modules/.bin/mocha --timeout 180000 integration-tests/jest/jest.request-pressure.repro.js
```

Compare `DD_REPRO_RUN`, `DD_REPRO_FINAL`, warning logs, and `DD_REPRO_INTAKE` between the two versions. In
particular, look for a similar number of attempts but higher `errors`, fewer completed intake requests, or flush
deadline warnings on v6.11.0.

In an equivalent default-mode execution collected while adding this scenario, both versions created 22 requests and
reached a maximum queue depth of 10. v6.1.0 recorded no request errors and eventually delivered all 22 requests;
v6.11.0 recorded 16 aborted requests and only 6 responses. v6.1.0's maximum socket-assignment wait reached about 30
seconds because requests left by the first `runCLI` call were still draining during the second call. This isolates the
bounded request-lifecycle behavior from changes in the number or size of payloads. In v6.11.0, each request callback
error increments both `endpoint_payload.requests_errors` and `endpoint_payload.dropped`, matching the paired telemetry
increase.

With the dedicated eight-socket Test Optimization agent, the same default execution delivered all 22 requests with
no errors. It used eight active sockets, queued at most three requests, and reduced the maximum socket-assignment wait
from about 30 seconds to about 3.1 seconds while preserving the final-flush deadline.

To specifically exercise parameterized-test handling, use `DD_REPRO_PAYLOAD_SOURCE=parameters`. This mode is useful
for detecting payload amplification from changes in Jest's `test.each` instrumentation:

```sh
DD_REPRO_PAYLOAD_SOURCE=parameters \
JEST_VERSION=30.0.5 \
  ./node_modules/.bin/mocha --timeout 120000 integration-tests/jest/jest.request-pressure.repro.js
```

In an equivalent two-run execution collected while adding this scenario, parameter mode produced 4 requests and no
errors on v6.1.0, versus 14 requests and 8 aborted requests on v6.11.0. The v6.11.0 output reported a maximum queue
depth of 6 and a maximum socket-assignment wait of about 9.2 seconds. Commit `11580c230` (preserving Jest parameters
across retries) is a likely payload-amplification change if the affected suite uses `test.each`. With the dedicated
agent, all 14 parameter-mode requests completed without errors or socket queueing.
