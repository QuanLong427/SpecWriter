"""Resolve GraphRAG response citations to a verified chapter-prefix manifest. No model calls."""
import hashlib
import json
import re
import sys
from pathlib import Path

import pandas as pd

root = Path(sys.argv[1]).resolve()
answer_path = Path(sys.argv[2]).resolve()
if answer_path.parent.parent != root or answer_path.parent.name != "queries":
    raise ValueError("Answer must be in this snapshot's queries directory")
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
answer = answer_path.read_text(encoding="utf-8")
tables = {}


def table(name):
    if name not in tables:
        path = root / "output" / (name + ".parquet")
        tables[name] = pd.read_parquet(path) if path.exists() else pd.DataFrame()
    return tables[name]


def values(value):
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    return list(value) if hasattr(value, "__iter__") else []


def row_id(value):
    try:
        return str(int(value))
    except (ValueError, TypeError):
        return str(value)


def rows(name, ids, field="human_readable_id"):
    data = table(name)
    if data.empty or field not in data:
        return []
    wanted = set(map(str, ids))
    return [row for _, row in data.iterrows() if row_id(row[field]) in wanted]


types = {"sources": "text_units", "text units": "text_units", "text_units": "text_units",
         "entities": "entities", "relationships": "relationships", "reports": "community_reports",
         "community reports": "community_reports", "community_reports": "community_reports"}
citations = []
for block in re.findall(r"\[Data:\s*([^\]]+)\]", answer, re.IGNORECASE):
    for label, ids in re.findall(r"([A-Za-z_ ]+)\s*\(([^)]+)\)", block):
        label = label.strip().lower()
        name = types.get(label, label)
        citations.extend((name, number) for number in re.findall(r"\b\d+\b", ids))
citations = list(dict.fromkeys(citations))[:32]
sources, unresolved = [], []
files = {item["name"]: item for item in manifest["files"]}

for name, citation in citations:
    cited = rows(name, [citation])
    if name == "community_reports" and not cited:
        cited = rows(name, [citation], "community")
    unit_ids = []
    if name == "text_units":
        units = cited
    else:
        for item in cited:
            unit_ids.extend(values(item.get("text_unit_ids")))
            if name == "community_reports":
                for community in rows("communities", [row_id(item.get("community"))], "community"):
                    unit_ids.extend(values(community.get("text_unit_ids")))
        units = rows("text_units", unit_ids, "id")
    resolved = False
    for unit in units:
        for document in rows("documents", values(unit.get("document_ids")), "id"):
            filename = re.split(r"[/\\]", str(document.get("title", "")))[-1]
            # Default readers may omit .txt from the title. Resolve only exact chapter file names.
            if filename not in files and filename + ".txt" in files:
                filename += ".txt"
            info = files.get(filename)
            if info is None:
                continue
            # Preserve CRLF bytes: the manifest hashes the exact accepted UTF-8 prose.
            body = (root / "input" / filename).read_bytes().decode("utf-8")
            if hashlib.sha256(body.encode("utf-8")).hexdigest() != info["bodyHash"]:
                raise ValueError("Citation source body hash mismatch")
            text = str(unit.get("text", ""))
            excerpt = text[:1200] if text and text in body else ""
            source = {"citationType": name, "citationId": citation, "chapter": info["chapter"],
                      "revision": info["revision"], "bodyHash": info["bodyHash"], "excerpt": excerpt}
            if source not in sources:
                sources.append(source)
            resolved = True
            if len(sources) >= 64:
                break
        if len(sources) >= 64:
            break
    if not resolved:
        unresolved.append({"citationType": name, "citationId": citation})
    if len(sources) >= 64:
        break
print(json.dumps({"sources": sources, "unresolvedCitations": unresolved}, ensure_ascii=False))
