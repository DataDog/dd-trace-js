#include <uv.h>

#include "Histogram.hpp"

namespace datadog {
  class EventLoop : public Histogram {
    public:
      EventLoop();

      void enable();
      void disable();

      static void check_cb (uv_check_t* handle);
    private:
      uv_check_t check_handle_;
      uint64_t check_usage_;

      uint64_t usage ();
  };
}
