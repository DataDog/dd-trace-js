#pragma once

#include <uv.h>

#include "Collector.hpp"
#include "Object.hpp"

namespace datadog {
  class Process : public Collector {
    public:
      void enable();
      void disable();
      void inject(Object carrier);
    private:
      bool enabled_;
      uv_rusage_t usage_;
  };
}
