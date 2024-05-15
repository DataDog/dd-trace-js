# End-to-End Benchmarking

The purpose of this folder is to be able to test the overhead of dd-trace on an
application. The primary focus here is on easily measurable metrics like
latency, RPS and throughput.

We're using a sample app called AcmeAir, which is used by Node.js to benchmark
itself (results are at <https://benchmarking.nodejs.org/>). Load is produced
with [autocannon](https://npm.im/autocannon), which also gives us results. We
test with and without the tracer to get a measure of overhead. We test using two
separate endpoints that are measured independently, to get a measure of worst
case (a static landing page) and a more realistic case (a DB call is done).

## Requirements

This test should work with all versions of Node.js supported by dd-trace. In
addition, the sample app uses MongoDB, so you'll have to have that running and
listening on the default port. If you're set up with the `docker-compose.yml` in
the root of this repo, you should be ready.

## Usage

To start the test, run `npm run bench:e2e`. This will install AcmeAir if it hasn't
yet been installed, and populate MongoDB if that hasn't already been done.

Next, it will run three tests for 10 seconds each, sequentially, on each of the
2 endpoints. The three tests are:

1. Without any tracing (i.e. a control test)
2. With async hooks enabled
3. With tracing enabled

That means 60 seconds of testing. Results will appear on stdout.

You can change the duration of the tests by setting the `DD_BENCH_DURATION`
environment variable to the number of seconds to run. Keep in mind that this
will be run 6 times (the three tests above on two endpoints), so if you set it
to `60`, you'll have to wait 6 minutes before it's done.

### Profiling, Method 1

To profile the app, the easiest thing to do is set the `DD_BENCH_PROF`
environment variable to a truthy string. This adds `--prof` to the node
processes, which writes a file called `isolate-0x${SOMEHEX}-${PID}-v8.log` for
each of the 4 tests. You can then use `node --prof-process` or a tool like
[pflames](https://npm.im/pflames) to view the profile data.

### Profiling, Method 2

You can run the app manually, using a tool like [0x](https://npm.im/0x) to get
profiling data. To do that, you'll need to run the fake agent (`node
fake-agent.js`) and run the app using `preamble.js` as a pre-require. You'll also
need to set `DD_BENCH_TRACE_ENABLE=1`, which is the switch used to turn on
tracing for the test script (leave it off to get a non-traced baseline).

For example, you might use a shell script like this:

```
node fake-agent.js > /dev/null &
FAKE_AGENT_PID=$!
cd acmeair-nodejs
DD_BENCH_TRACE_ENABLE=1 0x -P 'autocannon http://localhost:$PORT/' -- node -r ../preamble.js app.js
# Ctrl-C when it's done
kill $FAKE_AGENT_PID
```
