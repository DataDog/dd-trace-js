# Benchmarks

This directory contains several different types of benchmarks.

Some of these benchmarks rely on [sirun](https://github.com/DataDog/sirun/) for execution.

## Running Benchmarks via Docker

Docker allows the execution of benchmarks without needing to install and configure your development environment. For example, package installation and installation of sirun is performed automatically.

In order to run benchmarks using Docker, issue the following commands from the root of the project:

```sh
# Build the Docker Image
$ docker build -t dd-trace-benchmark -f benchmark/sirun/Dockerfile .

# Run the Docker Container
$ docker run -it --platform=linux/amd64 dd-trace-benchmark bash
cd /app/benchmark/sirun
./runall.sh
cat results.ndjson
```

The `--platform` flag is required when running benchmarks on a non-x86 system, such as a macOS computer with the M1 chip.
