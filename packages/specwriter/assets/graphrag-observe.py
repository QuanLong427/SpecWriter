"""Observe GraphRAG 3.3 requests without saving prompts, responses or credentials.

GraphRAG's aggregate metrics replay token usage on local cache hits. Observe each
request before aggregation so those historic tokens are not billed a second time.
This is a version-pinned compatibility hook, not a model provider implementation.
"""
import json
import math
import runpy
import sys
import threading
from pathlib import Path


def main():
    destination = Path(sys.argv[1])
    destination.parent.mkdir(parents=True, exist_ok=True)
    mutex = threading.Lock()

    def emit(record):
        with mutex, destination.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")

    from graphrag_llm.metrics.memory_metrics_store import MemoryMetricsStore
    from graphrag_llm.config import ModelConfig
    from graphrag_llm.metrics.default_metrics_processor import DefaultMetricsProcessor

    original_update = MemoryMetricsStore.update_metrics
    original_process = DefaultMetricsProcessor.process_metrics

    def process(self, *, model_config: ModelConfig, metrics, input_args, response):
        original_process(self, model_config=model_config, metrics=metrics,
                         input_args=input_args, response=response)
        # This field is carried through the local cache along with historic usage.
        from graphrag_llm.types import LLMEmbeddingResponse, LLMCompletionResponse
        if isinstance(response, LLMEmbeddingResponse):
            metrics["specwriter_embedding"] = 1
        elif isinstance(response, LLMCompletionResponse):
            metrics["specwriter_completion"] = 1

    fields = {"attempted_request_count", "successful_response_count", "failed_response_count",
              "cached_responses", "responses_with_tokens", "prompt_tokens", "completion_tokens",
              "total_tokens", "retries", "specwriter_embedding", "specwriter_completion"}

    def update(self, *, metrics):
        values = {key: value for key, value in metrics.items() if key in fields
                  and isinstance(value, (int, float)) and not isinstance(value, bool)
                  and math.isfinite(value) and value >= 0}
        # Thread-runner duration updates are not additional model requests.
        if "attempted_request_count" in values:
            emit({"model": self.id, "metrics": values})
        original_update(self, metrics=metrics)

    DefaultMetricsProcessor.process_metrics = process
    MemoryMetricsStore.update_metrics = update
    emit({"observer": 1})
    sys.argv = ["graphrag", *sys.argv[2:]]
    try:
        runpy.run_module("graphrag", run_name="__main__")
    finally:
        emit({"finished": True})


if __name__ == "__main__":
    main()
