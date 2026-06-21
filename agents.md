AGENTS.md - Agent Onboarding & Operational Notes

Purpose
-------
Compact, high-signal instructions for automated agents (OpenCode sessions) working in this repo. Include only facts an agent would likely miss without help.

Quick facts
-----------
- Repo: local Ember v1 monorepo (Electron main + Vite renderer).
- Tooling: pnpm workspaces, Vite, TypeScript (strict), Zod (ipc-schema), Vitest, chokidar, CodeMirror 6.
- v1 constraints: desktop-only, local filesystem only, no telemetry, no extensions.

Where to inspect first (in order)
--------------------------------
1. packages/ipc-schema — Zod schemas (single source of truth for IPC shapes).
2. packages/vfs — VFS behavior: atomic writes and chokidar watcher.
3. packages/document-store — canonical document model and undo/redo.
4. apps/ember-electron/main — wiring of CommandBus, VFS, DocumentStore, and IPC handlers.
5. apps/ember-electron/renderer — Vite React app, CodeMirror integration, Zustand stores.

Essential commands
------------------
- Install deps (root):
  pnpm install
- Run tests (all packages):
  pnpm -w -r test
- Start renderer dev server (Vite):
  pnpm --filter "apps/ember-electron/renderer" dev
- Start Electron main (dev):
  pnpm --filter "apps/ember-electron/main" dev

Notes
-----
- Start the renderer dev server before starting Electron main in dev mode so the renderer can load HMR content.
- Use pnpm workspace filters ("--filter <pkg>") for package-local scripts.
- There is not necessarily a single root package.json; inspect apps/ and packages/.

IPC & validation
----------------
- All IPC messages are validated with Zod in packages/ipc-schema. Import and reuse these schemas in both processes.
- RPCs use requestId (UUID); responses are { ok: true, result } or { ok: false, error }.

Key invariants (do not violate)
-------------------------------
- Canonical text/undo/redo lives in Electron main (DocumentStore). Renderer must not directly mutate canonical buffers.
- VFS is the only writer to disk; always use VFS API. Writes accept expectedEtag to detect races.
- ETag (v1) format: "mtime:<ms>|size:<bytes>". Do not substitute hashing in v1.

Editor adapter (renderer) rules
--------------------------------
- CodeMirror 6 is the editor. Adapter must coalesce edits before calling applyEdits: short debounce ≈60ms, long flush ≈400ms.
- applyEdits should include clientId and baseVersion when known. On stale/conflict, call getDocumentSnapshot and reset the buffer.
- Map undo/redo to domain RPCs (undo/redo). Do not rely on CodeMirror local history for authoritative state.

Testing guidance
----------------
- Focus unit tests on packages/document-store and packages/vfs first when debugging state or persistence issues.
- Integration to validate: open → edit → save, external edit while clean (auto-reload), external edit while dirty (document.conflict + user prompt).
- Use `pnpm --filter <pkg> test` for package-level test runs.

Common pitfalls
---------------
- Never mutate the renderer's buffer to "fix" canonical state — always go through RPCs to DocumentStore.
- File watcher events are coalesced; tests expecting immediate vfs.changed events may need a small delay or direct VFS assertions.
- When adding new top-level dependencies, update pnpm-workspace.yaml and run `pnpm install` at the repo root.

PR & editing conventions
-----------------------
- Keep changes small and focused. Update packages/ipc-schema first whenever changing IPC shapes and then update both main and renderer.
- Preserve strict TypeScript settings and add tests for behavioral changes.

Don't waste time on
------------------
- VS Code extension compatibility (explicitly out of scope for v1).
- Telemetry instrumentation (none in v1).

Contact
-------
- If unsure, open an issue with package name, failing command, and minimal reproduction steps.
