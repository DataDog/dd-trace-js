// changed(): 1 if V8's continuation-preserved embedder data (where Node's
// AsyncContextFrame keeps every AsyncLocalStorage value) differs by identity
// from the value seen on the previous call, else 0.
#include <node.h>
#include <v8-fast-api-calls.h>

using namespace v8;

static Global<Value>& last = *new Global<Value>(); // leaked: a static destructor would run after the isolate is gone
static double fastCalls = 0;
static double slowCalls = 0;

static inline int32_t Check (Isolate* isolate) {
  HandleScope scope(isolate);
  Local<Value> current = isolate->GetContinuationPreservedEmbedderData();
  if (last == current) return 0;
  last.Reset(isolate, current);
  return 1;
}

static void Slow (const FunctionCallbackInfo<Value>& info) {
  slowCalls++;
  info.GetReturnValue().Set(Check(info.GetIsolate()));
}

static int32_t Fast (Local<Value> receiver, FastApiCallbackOptions& options) {
  fastCalls++;
  return Check(options.isolate);
}

static void Counts (const FunctionCallbackInfo<Value>& info) {
  Isolate* isolate = info.GetIsolate();
  Local<Array> result = Array::New(isolate, 2);
  result->Set(isolate->GetCurrentContext(), 0, Number::New(isolate, fastCalls)).Check();
  result->Set(isolate->GetCurrentContext(), 1, Number::New(isolate, slowCalls)).Check();
  info.GetReturnValue().Set(result);
}

static CFunction fastChanged = CFunction::Make(Fast);

NODE_MODULE_INIT () {
  Isolate* isolate = context->GetIsolate();
  Local<FunctionTemplate> changed = FunctionTemplate::New(
    isolate, Slow, Local<Value>(), Local<Signature>(), 0,
    ConstructorBehavior::kThrow, SideEffectType::kHasSideEffect, &fastChanged);
  exports->Set(context, String::NewFromUtf8Literal(isolate, "changed"),
    changed->GetFunction(context).ToLocalChecked()).Check();
  exports->Set(context, String::NewFromUtf8Literal(isolate, "counts"),
    FunctionTemplate::New(isolate, Counts)->GetFunction(context).ToLocalChecked()).Check();
}
