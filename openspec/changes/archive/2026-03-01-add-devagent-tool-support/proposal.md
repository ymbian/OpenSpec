## Why

Users running `openspec init` see a "Select tools to set up" multi-select that lists 24 supported AI coding assistants. DevAgent is not in that list, so teams using DevAgent cannot configure OpenSpec skills and slash commands for it from the init flow. Adding DevAgent as a selectable tool removes that gap and keeps the supported-tool set aligned with the ecosystem.

## What Changes

- Add **DevAgent** to the built-in AI tool list in OpenSpec so it appears in the init/update "Select tools" multi-select.
- Use a single source of truth: one new entry in `AI_TOOLS` in `src/core/config.ts` with `name`, `value`, `successLabel`, and `skillsDir` (e.g. `.devagent`). No new CLI flags or commands.
- Ensure `openspec init --tools devagent` and interactive selection of DevAgent create skills under `.<skillsDir>/skills/` and commands under `.<skillsDir>/commands/` using the same pipeline as existing tools (no new adapter required for minimal support; command format can follow an existing adapter or a later change).
- Update specs and tests so DevAgent is a first-class selectable tool (detection, validation, success output).

## Capabilities

### New Capabilities

- None. This change only extends the existing tool list and path behavior.

### Modified Capabilities

- **ai-tool-paths**: Require that the `devagent` tool is present in `AI_TOOLS` with a defined `skillsDir` (e.g. `.devagent`) so skill/command generation paths are specified for DevAgent.
- **cli-init**: The set of selectable tools SHALL include DevAgent when it is present in the supported tools configuration; non-interactive `--tools devagent` SHALL be accepted and SHALL configure DevAgent.

## Impact

- **Code**: `src/core/config.ts` (add one `AIToolOption`), `test/core/available-tools.test.ts` and any init/update tests that assert on tool list or tool IDs.
- **APIs**: None. All consumers already use `AI_TOOLS` / `getToolsWithSkillsDir()` / `getAvailableTools()`.
- **Dependencies**: None.
- **Docs**: Optional: mention DevAgent in supported-tools or CLI docs so users know they can select it.
