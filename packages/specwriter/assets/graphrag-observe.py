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

    if sys.platform == "win32":
        # Snapshot IDs + upstream cache keys can exceed Windows' legacy 260-char limit.
        # Keep storage in the same snapshot; no global OS setting or shared cache needed.
        from graphrag_storage.file_storage import FileStorage
        from graphrag_storage.storage_factory import register_storage
        from graphrag_vectors.lancedb import LanceDBVectorStore
        from graphrag_vectors.vector_store_factory import register_vector_store
        import ctypes

        def short_database_path(path):
            absolute = str(Path(path).resolve())
            extended = absolute if absolute.startswith("\\\\?\\") else (
                "\\\\?\\UNC\\" + absolute[2:] if absolute.startswith("\\\\") else "\\\\?\\" + absolute)
            Path(extended).mkdir(parents=True, exist_ok=True)
            short_path = ctypes.windll.kernel32.GetShortPathNameW
            short_path.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint]
            short_path.restype = ctypes.c_uint
            buffer = ctypes.create_unicode_buffer(32768)
            length = short_path(extended, buffer, len(buffer))
            result = buffer.value if 0 < length < len(buffer) else absolute
            if result.startswith("\\\\?\\UNC\\"):
                result = "\\\\" + result[8:]
            elif result.startswith("\\\\?\\"):
                result = result[4:]
            # Lance's native writer strips the extended prefix. Use the same directory's
            # Windows short name, without moving vectors or sharing another snapshot.
            if len(result) + 100 >= 260:
                raise RuntimeError("LanceDB needs a shorter book path on this Windows volume; "
                                   "use a directory such as E:/novels/book (no model was called in preflight)")
            return result

        # Check before GraphRAG's validation/extraction can consume paid requests.
        if "--root" in sys.argv:
            root = Path(sys.argv[sys.argv.index("--root") + 1])
            short_database_path(root / "output" / "lancedb")

        class LongPathFileStorage(FileStorage):
            def __init__(self, base_dir, **kwargs):
                absolute = str(Path(base_dir).resolve())
                if not absolute.startswith("\\\\?\\"):
                    absolute = ("\\\\?\\UNC\\" + absolute[2:]
                                if absolute.startswith("\\\\") else "\\\\?\\" + absolute)
                super().__init__(base_dir=absolute, **kwargs)

        register_storage("file", LongPathFileStorage)

        class ShortPathLanceDB(LanceDBVectorStore):
            def connect(self):
                self.db_uri = short_database_path(self.db_uri)
                return super().connect()

        register_vector_store("lancedb", ShortPathLanceDB)

    original_update = MemoryMetricsStore.update_metrics
    original_process = DefaultMetricsProcessor.process_metrics

    def process(self, *, model_config: ModelConfig, metrics, input_args, response):
        original_process(self, model_config=model_config, metrics=metrics,
                         input_args=input_args, response=response)
        # This field is carried through the local cache along with historic usage.
        from graphrag_llm.types import LLMEmbeddingResponse, LLMCompletionResponse
        if isinstance(response, LLMEmbeddingResponse):
            metrics["specwriter_embedding"] = 1
            if getattr(model_config, "specwriter_local", False):
                metrics["specwriter_local"] = 1
        elif isinstance(response, LLMCompletionResponse):
            metrics["specwriter_completion"] = 1

    fields = {"attempted_request_count", "successful_response_count", "failed_response_count",
              "cached_responses", "responses_with_tokens", "prompt_tokens", "completion_tokens",
              "total_tokens", "retries", "specwriter_embedding", "specwriter_completion", "specwriter_local"}

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
