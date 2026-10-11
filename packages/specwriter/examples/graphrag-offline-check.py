"""Exercise the installed 3.3.0 delta/merge helpers and citation resolver with tiny parquet fixtures."""
import asyncio
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pandas as pd
from graphrag.index.update.incremental_index import concat_dataframes, get_delta_docs


class Tables:
    def __init__(self, frame=None):
        self.frame = frame

    async def read_dataframe(self, name):
        assert name == "documents"
        return self.frame.copy(deep=True)

    async def write_dataframe(self, name, frame):
        assert name == "documents"
        self.frame = frame.copy(deep=True)


async def check_delta():
    old = Tables(pd.DataFrame([{"title": "0001.txt", "human_readable_id": 0}]))
    full = pd.DataFrame([{"title": "0001.txt"}, {"title": "0002.txt"}])
    delta = await get_delta_docs(full, old)
    assert delta.new_inputs.title.tolist() == ["0002.txt"]
    assert delta.deleted_inputs.empty
    output = Tables()
    merged = await concat_dataframes("documents", old, Tables(delta.new_inputs), output)
    assert merged.human_readable_id.tolist() == [0, 1]
    assert old.frame.title.tolist() == ["0001.txt"]


asyncio.run(check_delta())
root = Path(sys.argv[1]).resolve()
resolver = Path(sys.argv[2]).resolve()
for name in ["input", "output", "queries"]:
    (root / name).mkdir(parents=True, exist_ok=True)
body = "林舟发现钥匙。\r\n他收好钥匙。"
(root / "input/0001.txt").write_bytes(body.encode("utf-8"))
manifest = {"schemaVersion": 1, "snapshotId": "fixture", "atChapter": 1, "files": [
    {"name": "0001.txt", "chapter": 1, "revision": 7, "bodyHash": hashlib.sha256(body.encode("utf-8")).hexdigest()}]}
(root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
frames = {
    "documents": [{"id": "d1", "title": "0001.txt"}, {"id": "future", "title": "0002.txt"}],
    "text_units": [{"id": "t1", "human_readable_id": 0, "document_ids": ["d1"], "text": body},
                   {"id": "t2", "human_readable_id": 99, "document_ids": ["future"], "text": "未来泄露"}],
    "entities": [{"id": "e1", "human_readable_id": 1, "text_unit_ids": ["t1"]}],
    "relationships": [{"id": "r1", "human_readable_id": 2, "text_unit_ids": ["t1"]}],
    "community_reports": [{"id": "rpt1", "human_readable_id": 3, "community": 42}],
    "communities": [{"community": 42, "text_unit_ids": ["t1"]}],
}
for name, rows in frames.items():
    pd.DataFrame(rows).to_parquet(root / "output" / (name + ".parquet"))
answer = root / "queries/fixture.answer.txt"
answer.write_text("[Data: Sources (0, 99, 999); Entities (1); Relationships (2); Reports (3)]", encoding="utf-8")
result = subprocess.run([sys.executable, "-X", "utf8", str(resolver), str(root), str(answer)], capture_output=True, text=True, encoding="utf-8", check=True)
citations = json.loads(result.stdout)
assert len(citations["sources"]) == 4
assert all(item["chapter"] == 1 and item["revision"] == 7 and item["excerpt"] == body for item in citations["sources"])
assert {item["citationId"] for item in citations["unresolvedCitations"]} == {"99", "999"}
# Current 3.3 artifacts use a scalar document_id, rather than the legacy array.
current_units = [{**row, "document_id": row["document_ids"][0]} for row in frames["text_units"]]
for row in current_units:
    del row["document_ids"]
pd.DataFrame(current_units).to_parquet(root / "output/text_units.parquet")
current = subprocess.run([sys.executable, "-X", "utf8", str(resolver), str(root), str(answer)], capture_output=True, text=True, encoding="utf-8", check=True)
assert json.loads(current.stdout) == citations
print(json.dumps({"incrementalDeltaCompatible": True, "citationParquetCompatible": True,
                  "scalarDocumentIdCompatible": True, "crlfHashPreserved": True, "modelCalls": 0}))
