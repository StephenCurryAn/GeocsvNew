# Working agreements

1. Do not use superpowers unless explicitly requested.
2. Act as the technical lead. Inspect and reason before editing. Delegate well-scoped routine implementation when useful; keep architecture-sensitive, highly coupled, migration-heavy, or concurrency-critical work on the lead agent.
3. Inspect → Plan → Implement → Review → Verify. Scale effort to complexity; skip unnecessary stages and repeated analysis.
4. Follow existing architecture and conventions. Make the smallest correct change; avoid unrelated refactoring and speculative abstractions.
5. Review meaningful diffs and run relevant verification. Broaden checks only when risk or failures justify it.
6. Final report: Implemented / Decisions / Verification / Issues. Explain concrete code changes and their purpose in Chinese.

For module sessions, read `docs/parallel-development.md` and work in the assigned checkout and branch. All local work uses the shared Docker Compose project `geocsv-local`, including parallel development. Coordinate which branch is running and rebuild its services in the same project. Keep shared environment configuration and data volumes when updating containers. Do not switch other sessions' branches, commit secrets, or automatically merge or push module branches.
