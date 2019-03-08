#include <nan.h>

#include "EventLoop.hpp"
#include "HistogramAdapter.hpp"
#include "Object.hpp"

using namespace v8;

namespace datadog {
  EventLoop* eventLoop = new EventLoop();
  HistogramAdapter* histogramAdapter = new HistogramAdapter(eventLoop);

  static NAN_METHOD(start) {
    eventLoop->enable();
  }

  static NAN_METHOD(stop) {
    eventLoop->disable();
  }

  static NAN_METHOD(stats) {
    Object obj;

    obj.set("eventLoop", histogramAdapter->to_object());

    info.GetReturnValue().Set(obj.to_json());

    eventLoop->reset();
  }

  NAN_MODULE_INIT(init) {
    Object obj = Object(target);

    obj.set("start", start);
    obj.set("stop", stop);
    obj.set("stats", stats);
  }

  NODE_MODULE(metrics, init);
}
