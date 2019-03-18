#include "Process.hpp"

namespace datadog {
  void Process::inject(Object carrier) {
    uv_rusage_t usage;
    uv_getrusage(&usage);

    Object cpu;

    cpu.set("user", time_to_micro(usage.ru_utime) - time_to_micro(usage_.ru_utime));
    cpu.set("system", time_to_micro(usage.ru_stime) - time_to_micro(usage_.ru_stime));

    carrier.set("cpu", cpu);

    usage_ = usage;
  }
}
