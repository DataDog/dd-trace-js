#include "Collector.hpp"

namespace datadog {
  uint64_t Collector::time_to_micro(uv_timeval_t timeval) {
    return timeval.tv_sec * 1e6 + timeval.tv_usec;
  }
}
