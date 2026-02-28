## 1. Config: Add DevAgent to AI_TOOLS

- [x] 1.1 Add DevAgent entry to `AI_TOOLS` in `src/core/config.ts` with `name: 'DevAgent'`, `value: 'devagent'`, `available: true`, `successLabel: 'DevAgent'`, `skillsDir: '.devagent'`, in alphabetical order by display name (e.g. after Crush, before Factory Droid)

## 2. Tests

- [x] 2.1 In `test/core/available-tools.test.ts`, add a test that when `.devagent` directory exists, `getAvailableTools()` returns the devagent tool with correct `name`, `value`, and `skillsDir`
- [x] 2.2 Update or add init/update tests that assert on tool list or valid tool IDs so that `devagent` is included where appropriate (e.g. `--tools devagent` succeeds, or available tool count includes DevAgent)
- [x] 2.3 Run full test suite and fix any tests that break due to increased tool count or new tool ID (e.g. hardcoded list length or tool IDs)

## 3. Verification

- [x] 3.1 Run `openspec init --tools devagent` in a temp project and confirm `.devagent/skills/` and `.devagent/commands/` are created with expected content
- [x] 3.2 Run `openspec init` interactively (or in a test) and confirm DevAgent appears in the Select tools list
