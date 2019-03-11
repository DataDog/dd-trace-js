#include "EventLoop.hpp"

namespace datadog {
  // http://docs.libuv.org/en/v1.x/design.html#the-i-o-loop
  EventLoop::EventLoop() {
    uv_check_init(uv_default_loop(), &check_handle_);
    uv_unref(reinterpret_cast<uv_handle_t*>(&check_handle_));

    check_handle_.data = (void*)this;
    check_usage_ = usage();
  }

  void EventLoop::check_cb (uv_check_t* handle) {
    EventLoop* self = (EventLoop*)handle->data;
    uint64_t usage = self->usage();

    self->histogram_.add(usage - self->check_usage_);
    self->check_usage_ = usage;
  }

  void EventLoop::enable() {
    uv_check_start(&check_handle_, &EventLoop::check_cb);
  }

  void EventLoop::disable() {
    uv_check_stop(&check_handle_);
    histogram_.reset();
  }

  uint64_t EventLoop::usage() {
    uv_rusage_t usage;
    uv_getrusage(&usage);

    return (
      (usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) * 1e6 +
      (usage.ru_utime.tv_usec + usage.ru_stime.tv_usec)
    );
  }

  void EventLoop::inject(Object carrier) {
    Object value;

    value.set("min", histogram_.min());
    value.set("max", histogram_.max());
    value.set("sum", histogram_.sum());
    value.set("avg", histogram_.avg());
    value.set("count", histogram_.count());

    carrier.set("eventLoop", value);

    histogram_.reset();
  }
}
