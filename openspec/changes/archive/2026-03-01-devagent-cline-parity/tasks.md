## 1. DevAgent command adapter

- [x] 1.1 Create `src/core/command-generation/adapters/devagent.ts` with `toolId: 'devagent'`, `getFilePath(commandId)` returning `path.join('.devagentrules', 'workflows', \`opsx-${commandId}.md\`)`, and `formatFile(content)` returning the same Markdown structure as the Cline adapter (`# ${content.name}`, description, body)
- [x] 1.2 Export `devagentAdapter` from `src/core/command-generation/adapters/index.ts` and register it in `CommandAdapterRegistry` in `src/core/command-generation/registry.ts`

## 2. Legacy cleanup

- [x] 2.1 Add `'devagent': { type: 'files', pattern: '.devagentrules/workflows/openspec-*.md' }` to `LEGACY_SLASH_COMMAND_PATHS` in `src/core/legacy-cleanup.ts`

## 3. Tests

- [x] 3.1 In `test/core/command-generation/adapters.test.ts`, add tests for DevAgent adapter: `toolId` is `'devagent'`, `getFilePath('explore')` returns path ending with `.devagentrules/workflows/opsx-explore.md` (using path.join), and `formatFile(sampleContent)` produces Markdown with title, description, and body
- [x] 3.2 In `test/core/command-generation/registry.test.ts`, add or extend test so `CommandAdapterRegistry.get('devagent')` returns the DevAgent adapter
- [x] 3.3 In `test/core/init.test.ts`, update or add test that when init runs with `--tools devagent`, command files are created under `.devagentrules/workflows/` (e.g. `opsx-explore.md`) with expected content
- [x] 3.4 Run relevant test suite and fix any failures (e.g. legacy-cleanup test that asserts on registry tool IDs)

## 4. Verification

- [x] 4.1 Run `openspec init --tools devagent` in project root and confirm `.devagentrules/workflows/opsx-*.md` files exist with Cline-style Markdown content
