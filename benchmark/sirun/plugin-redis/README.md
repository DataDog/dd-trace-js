Measures the per-command redis hot path: `bindStart` runs `command.toUpperCase`,
the config filter, the per-connection service cache, then `formatCommand` to
build the `redis.raw_command` string and `startSpan`. Variants cover the common
short command (get), per-arg truncation (a value past MAX_ARG_LENGTH), the
wide-arg loop that hits MAX_COMMAND_LENGTH (mset with many pairs), and a mixed
rotation of get/set/hset.
