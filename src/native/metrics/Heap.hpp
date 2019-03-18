#pragma once

#include <string>
#include <vector>
#include <v8.h>

#include "Collector.hpp"
#include "Object.hpp"

namespace datadog {
  class Heap : public Collector {
    public:
      void inject(Object carrier);
  };
}
