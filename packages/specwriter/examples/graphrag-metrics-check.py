"""Exercise the observer against real GraphRAG classes, without a model/API call."""
import importlib.util
import asyncio
import json
import runpy
import sys
from pathlib import Path

observer, destination = sys.argv[1:3]
spec = importlib.util.spec_from_file_location("specwriter_observer", observer)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def exercise(*args, **kwargs):
    from graphrag_llm.config import ModelConfig
    from graphrag_llm.metrics.default_metrics_processor import DefaultMetricsProcessor
    from graphrag_llm.metrics.memory_metrics_store import MemoryMetricsStore
    from graphrag_llm.types import LLMCompletionResponse, LLMEmbeddingResponse

    processor = DefaultMetricsProcessor()
    metrics = {"attempted_request_count": 1, "successful_response_count": 1,
               "failed_response_count": 0}
    completion = LLMCompletionResponse(id="fixture", choices=[], created=0,
                                     model="specwriter-test", object="chat.completion",
                                     usage={"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120})
    config = ModelConfig(model_provider="openai", model="specwriter-test", api_key="offline-placeholder")
    processor.process_metrics(model_config=config, metrics=metrics, input_args={}, response=completion)
    store = MemoryMetricsStore(id="openai/specwriter-test")
    store.update_metrics(metrics=metrics)
    # The official cache replays these same usage values, with cached_responses=1.
    store.update_metrics(metrics={**metrics, "cached_responses": 1})
    store.update_metrics(metrics={"runtime_duration_seconds": 0.5})
    embedding = LLMEmbeddingResponse(data=[], model="specwriter-embedding", object="list",
                                    usage={"prompt_tokens": 50, "total_tokens": 50})
    embedding_metrics = {"attempted_request_count": 1, "successful_response_count": 1,
                         "failed_response_count": 0}
    config.specwriter_local = True
    processor.process_metrics(model_config=config, metrics=embedding_metrics, input_args={}, response=embedding)
    MemoryMetricsStore(id="openai/specwriter-embedding").update_metrics(metrics=embedding_metrics)
    if sys.platform == "win32":
        from graphrag_storage.storage_config import StorageConfig
        from graphrag_storage.storage_factory import create_storage
        base = Path(destination).resolve().parent / "long-path-check" / ("w" * 120) / ("w" * 120)
        storage = create_storage(StorageConfig(type="file", base_dir=str(base))).child("extract_graph")
        async def roundtrip():
            key = "a" * 64 + "_v4"
            await storage.set(key, "long-path-fixture")
            assert await storage.get(key) == "long-path-fixture"
            await storage.delete(key)
        asyncio.run(roundtrip())
        from graphrag_vectors.index_schema import IndexSchema
        from graphrag_vectors.vector_store_config import VectorStoreConfig
        from graphrag_vectors.vector_store_factory import create_vector_store
        vectors = create_vector_store(VectorStoreConfig(type="lancedb", db_uri=str(base / "vectors")),
                                      IndexSchema(index_name="fixture", vector_size=2))
        vectors.connect()
        table = vectors.db_connection.create_table("fixture", [{"id": "local", "vector": [1.0, 0.0]}], mode="overwrite")
        assert table.search([1.0, 0.0]).limit(1).to_list()[0]["id"] == "local"


runpy.run_module = exercise
Path(destination).write_text('', encoding='utf-8')
sys.argv = [observer, destination, "index"]
module.main()
records = [json.loads(line) for line in Path(destination).read_text(encoding="utf-8").splitlines()]
assert len(records) == 5, records
assert records[1]["metrics"]["specwriter_completion"] == 1
assert records[2]["metrics"]["cached_responses"] == 1
assert records[3]["metrics"]["specwriter_embedding"] == 1
assert records[3]["metrics"]["specwriter_local"] == 1
print(json.dumps({"observerCompatible": True, "cachedUsageReplayExercised": True, "localEmbeddingTagged": True,
                  "windowsLongPathExercised": sys.platform == "win32", "modelCalls": 0}))
