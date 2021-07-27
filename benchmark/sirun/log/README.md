This test calls the internal logger on various log levels for 1000 iterations.

* `without-log` is the baseline that has logging disabled completely.
* `skip-log` has logs enabled but uses a log level that isn't so that the handler doesn't run.
* `with-debug` has logs enabled and sends a debug log.
* `with-error` has logs enabled and sends an error log.
