"""Shared request guard for the version-pinned GraphRAG observer.

Request attempts are reserved before invocation, inside cache and outside the
transport. Token/cost thresholds use responses; already in-flight calls may
overshoot. No prompts, responses or credentials are persisted by this guard.
"""
import threading


class BudgetStopped(BaseException):
    """Bypass upstream retry handlers: a budget stop must not trigger retries."""


class RequestBudget:
    def __init__(self, config, emit):
        self.config = config
        self.emit = emit
        self.lock = threading.Lock()
        self.requests = 0
        self.tokens = config.get("initialTokens", 0)
        self.cost = config.get("initialCost", 0)
        self.unknown = False
        self.stopped = False

    def stop(self):
        self.stopped = True
        self.emit({"budgetStopped": True})
        raise BudgetStopped("SpecWriter usage budget stopped further model requests")

    def reserve(self, model_config, kind):
        with self.lock:
            config = self.config
            if self.stopped or (config.get("unknownUsage", "block") == "block" and self.unknown):
                self.stop()
            if ("maxRequestsPerOperation" in config and self.requests >= config["maxRequestsPerOperation"]
                    or "maxObservedTokens" in config and self.tokens >= config["maxObservedTokens"]
                    or "maxEstimatedCost" in config and self.cost >= config["maxEstimatedCost"]):
                self.stop()
            # Verify prices before the first paid request when a cost threshold is active.
            local = getattr(model_config, "specwriter_local", False)
            rate = self.rate(model_config, kind)
            if "maxEstimatedCost" in config and not local and rate is None:
                self.stop()
            self.requests += 1

    def rate(self, model_config, kind):
        name = f"{model_config.model_provider}/{model_config.model}"
        return next((rate for rate in self.config.get("prices", {}).get("models", [])
                     if rate["model"] == name and rate["kind"] == kind), None)

    def observe(self, model_config, metrics, success):
        with self.lock:
            if getattr(model_config, "specwriter_local", False):
                return  # local BGE has no per-token API charge
            if not success or not metrics or not metrics.get("responses_with_tokens"):
                if "maxObservedTokens" in self.config or "maxEstimatedCost" in self.config:
                    self.unknown = True
                return
            input_tokens = metrics.get("prompt_tokens")
            output_tokens = metrics.get("completion_tokens", 0)
            if not isinstance(input_tokens, int) or not isinstance(output_tokens, int):
                self.unknown = True
                return
            self.tokens += input_tokens + output_tokens
            kind = "embedding" if metrics.get("specwriter_embedding") else "completion"
            rate = self.rate(model_config, kind)
            if rate:
                self.cost += (input_tokens * rate["inputPerMillion"]
                              + output_tokens * rate.get("outputPerMillion", 0)) / 1_000_000

    def wrap_metrics(self, original):
        def wrap(*, model_config, sync_middleware, async_middleware, metrics_processor):
            sync, async_fn = original(model_config=model_config, sync_middleware=sync_middleware,
                                      async_middleware=async_middleware, metrics_processor=metrics_processor)

            def guarded(**kwargs):
                self.reserve(model_config, "completion" if "messages" in kwargs else "embedding")
                success = False
                try:
                    response = sync(**kwargs)
                    success = True
                    return response
                finally:
                    self.observe(model_config, kwargs.get("metrics"), success)

            async def guarded_async(**kwargs):
                self.reserve(model_config, "completion" if "messages" in kwargs else "embedding")
                success = False
                try:
                    response = await async_fn(**kwargs)
                    success = True
                    return response
                finally:
                    self.observe(model_config, kwargs.get("metrics"), success)

            return guarded, guarded_async
        return wrap
