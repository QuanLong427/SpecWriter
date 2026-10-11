"""Verify request guards against installed GraphRAG middleware, with zero API calls."""
import asyncio
import importlib.util
import json
import os
import runpy
import sys
from pathlib import Path

observer, destination = sys.argv[1:3]
sys.path.insert(0, str(Path(observer).resolve().parent))
from specwriter_budget import BudgetStopped, RequestBudget
spec = importlib.util.spec_from_file_location("specwriter_observer", observer)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def exercise(*args, **kwargs):
    from graphrag_llm.config import ModelConfig
    from graphrag_llm.metrics.default_metrics_processor import DefaultMetricsProcessor
    from graphrag_llm.middleware.with_middleware_pipeline import with_middleware_pipeline
    from graphrag_llm.types import LLMCompletionResponse
    from graphrag_llm.middleware.with_metrics import with_metrics
    from graphrag_llm.retry.immediate_retry import ImmediateRetry

    calls = []
    config = ModelConfig(model_provider="openai", model="offline-test", api_key="placeholder")
    response = LLMCompletionResponse(id="fixture", choices=[{"index": 0, "message": {"role": "assistant", "content": "fixture"}, "finish_reason": "stop"}], created=0, model="offline-test",
                                    object="chat.completion", usage={"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30})

    def model(**kwargs):
        calls.append(1)
        return response

    async def async_model(**kwargs):
        await asyncio.sleep(0)
        return model(**kwargs)

    class Cache:
        def __init__(self):
            self.values = {}

        async def get(self, key):
            return self.values.get(key)

        async def set(self, key, value):
            self.values[key] = value

    sync, async_fn = with_middleware_pipeline(model_config=config, model_fn=model, async_model_fn=async_model,
        metrics_processor=DefaultMetricsProcessor(), cache=Cache(), cache_key_creator=lambda kwargs: str(kwargs["messages"]),
        request_type="chat", tokenizer=None, rate_limiter=None, retrier=None)
    sync(messages=[{"role": "user", "content": "one"}], metrics={})
    cached = {}
    sync(messages=[{"role": "user", "content": "one"}], metrics=cached)
    assert cached["cached_responses"] == 1 and len(calls) == 1
    try:
        sync(messages=[{"role": "user", "content": "two"}], metrics={})
        raise AssertionError("request limit did not stop")
    except BudgetStopped:
        pass
    assert len(calls) == 1

    # Async workers atomically reserve a shared budget before any await.
    guard = RequestBudget({"maxRequestsPerOperation": 2}, lambda item: None)
    _, guarded = guard.wrap_metrics(with_metrics)(model_config=config, sync_middleware=model,
        async_middleware=async_model, metrics_processor=DefaultMetricsProcessor())

    async def concurrent():
        async def request():
            try:
                await guarded(messages=[], metrics={})
                return True
            except BudgetStopped:
                return False
        return await asyncio.gather(*(request() for _ in range(8)))

    assert sum(asyncio.run(concurrent())) == 2 and len(calls) == 3

    # Token/cost/unknown thresholds use responses; retries cannot bypass reservations.
    rates = {"models": [{"model": "openai/offline-test", "kind": "completion", "inputPerMillion": 1, "outputPerMillion": 2}]}
    for limits in [{"maxObservedTokens": 30}, {"maxEstimatedCost": 0.00004, "prices": rates}]:
        guard = RequestBudget(limits, lambda item: None)
        fn, _ = guard.wrap_metrics(with_metrics)(model_config=config, sync_middleware=model,
            async_middleware=async_model, metrics_processor=DefaultMetricsProcessor())
        fn(messages=[], metrics={})
        try:
            fn(messages=[], metrics={})
            raise AssertionError("usage threshold did not stop")
        except BudgetStopped:
            pass
    unknown = RequestBudget({"maxObservedTokens": 100, "unknownUsage": "block"}, lambda item: None)
    unknown.observe(config, {}, True)
    try:
        unknown.reserve(config, "completion")
        raise AssertionError("unknown usage did not stop")
    except BudgetStopped:
        pass

    retried = []
    def failing(**kwargs):
        retried.append(1)
        raise ValueError("fixture transport failure")
    guard = RequestBudget({"maxRequestsPerOperation": 1}, lambda item: None)
    pipeline = __import__("importlib").import_module("graphrag_llm.middleware.with_middleware_pipeline")
    pipeline.with_metrics = guard.wrap_metrics(with_metrics)
    fn, _ = pipeline.with_middleware_pipeline(model_config=config, model_fn=failing, async_model_fn=async_model,
        metrics_processor=DefaultMetricsProcessor(), cache=None, cache_key_creator=lambda kwargs: "none",
        request_type="chat", tokenizer=None, rate_limiter=None, retrier=ImmediateRetry(max_retries=3))
    try:
        fn(messages=[], metrics={})
        raise AssertionError("retry bypassed budget")
    except BudgetStopped:
        pass
    assert len(retried) == 1


runpy.run_module = exercise
os.environ["SPECWRITER_USAGE_BUDGET"] = json.dumps({"schemaVersion": 1, "maxRequestsPerOperation": 1, "unknownUsage": "block"})
Path(destination).write_text('', encoding='utf-8')
sys.argv = [observer, destination, "index"]
module.main()
print(json.dumps({"budgetCompatible": True, "cacheBypassVerified": True, "concurrentReservationVerified": True,
                  "retryLimitVerified": True, "tokenAndCostThresholdsVerified": True, "modelCalls": 0}))
