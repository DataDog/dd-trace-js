#pragma once

// windows.h defines min and max macros.
#define NOMINMAX
#include <algorithm>
#undef min
#undef max

#include <stdint.h>

namespace datadog {
  class Histogram {
    public:
      uint64_t min();
      uint64_t max();
      uint64_t sum();
      uint64_t avg();
      uint64_t count();

      void reset();
      void add(uint64_t value);
    private:
      uint64_t min_;
      uint64_t max_;
      uint64_t sum_;
      uint64_t count_;
  };
}
