#pragma once

#include <algorithm>

namespace datadog {
  class Histogram {
    public:
      virtual void enable() = 0;
      virtual void disable() = 0;

      uint64_t min ();
      uint64_t max ();
      uint64_t sum ();
      uint64_t avg ();
      uint64_t count ();

      void reset();
    protected:
      void add(uint64_t value);
    private:
      uint64_t min_;
      uint64_t max_;
      uint64_t sum_;
      uint64_t count_;
  };
}
