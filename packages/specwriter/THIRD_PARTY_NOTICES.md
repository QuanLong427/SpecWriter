# Third-party notices

## Reused and modified material: ainovel-cli

- Project: https://github.com/voocel/ainovel-cli
- Revision: `638ca2445969b055a1013fedf8bf41c9d0b65c2a`
- Source: `internal/chapterfacts/facts.go`, https://github.com/voocel/ainovel-cli/blob/638ca2445969b055a1013fedf8bf41c9d0b65c2a/internal/chapterfacts/facts.go
- Attribution: voocel/ainovel-cli authors and contributors.
- License: Apache License 2.0, reproduced in `licenses/ainovel-cli-Apache-2.0.txt`.
- Modified files: `schemas/chapter-delta.schema.json` and the `ChapterDelta` contract in `src/types.ts`.
- Changes: translated the chapter-facts contract into JSON Schema / TypeScript; retained chapter title, summary, characters, key events, timeline, foreshadow operations, relationship changes, state changes and cast introductions. Added exact prose evidence, context/draft hashes, revision identity, world/belief scope, general fact records, defer/supersede operations, stable entities, causal narrative events, resource ledgers and hook dependencies. Removed engine-specific narrative classification and feedback fields. Runtime persistence, GraphRAG retrieval and validators are implemented for SpecWriter.

No project NOTICE file was present at the referenced revision. The upstream license and attribution are included in the distributed package. SpecWriter's own code remains under the repository's MIT license; adapted material retains its Apache-2.0 terms.

## Design references with no code copied

- InkOS: https://github.com/Narcooo/inkos, revision `8fc2ae57080b9821257dee3e37cc677e2b6f389a`. Its author intent / context / evidence-based state projection workflow informed the design. No AGPL-3.0 source, schemas or prompt text is incorporated.
- OpenSpec: https://github.com/Fission-AI/OpenSpec. Workflow concepts and Codex skill delivery informed the integration; no runtime dependency or copied implementation.
- Local Poirot project: memory retrieval / management separation informed the module boundary. No source code was copied.
- Microsoft GraphRAG: https://github.com/microsoft/graphrag and https://microsoft.github.io/graphrag/cli/. The default retrieval backend invokes the documented GraphRAG 3.3.x CLI in a separately installed Python environment. requirements-graphrag.txt pins version 3.3.0. No upstream code or prompts are bundled; generated prompts remain in the user's private provider workspace.

Runtime npm dependencies and their licenses are distributed through npm: Ajv (MIT) and YAML (ISC). Node's built-in SQLite API is used rather than bundling a separate database server.
