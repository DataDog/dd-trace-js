// This line must come before importing any instrumented module.
import tracer from "dd-trace";

if (true) {
  tracer.init({
    version: process.env.SOURCE_VERSION?.toString().trim(),
    env: "development",
    logInjection: true,
    service: process.env.DD_SERVICE,
    experimental: { enableGetRumData: true },
  });
}
export default tracer;
