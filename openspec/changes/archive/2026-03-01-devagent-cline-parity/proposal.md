## Why

DevAgent is a Cline-based fork that uses the same workflow format as Cline but different directory names: `.cline` → `.devagent`, `.clinerules` → `.devagentrules`. OpenSpec already lists DevAgent in init's tool selection and generates skills under `.devagent/skills/`, but has no command adapter for DevAgent, so `openspec init --tools devagent` skips command generation and users get no slash/workflow commands. To support DevAgent as a first-class integration (same functionality as Cline), we need command generation into `.devagentrules/workflows/` and legacy cleanup awareness for that path.

## What Changes

- Add a **DevAgent command adapter** that mirrors the Cline adapter: same Markdown format (header + description + body), path `.devagentrules/workflows/opsx-<id>.md`. Register it in `CommandAdapterRegistry` so init/update generate workflow files for DevAgent when selected.
- Add **DevAgent to legacy slash-command patterns** in `legacy-cleanup.ts` so future migrations can detect and upgrade old `.devagentrules/workflows/openspec-*.md` files.
- No change to `AI_TOOLS` or `skillsDir` (already `.devagent` from add-devagent-tool-support). No change to skill content or paths.

## Capabilities

### New Capabilities

- None. This extends existing command-generation and legacy-cleanup behavior.

### Modified Capabilities

- **command-generation**: Require that a DevAgent adapter is registered and that formatting/path for DevAgent follow the Cline-compatible pattern (`.devagentrules/workflows/opsx-<id>.md`, Markdown header format).
- **legacy-cleanup**: Require that legacy slash-command patterns include DevAgent (`.devagentrules/workflows/openspec-*.md`) for detection and cleanup during migration.

## Impact

- **Code**: New file `src/core/command-generation/adapters/devagent.ts` (adapter); `src/core/command-generation/registry.ts` (register adapter); `src/core/command-generation/adapters/index.ts` (export); `src/core/legacy-cleanup.ts` (add `devagent` entry to `LEGACY_SLASH_COMMAND_PATHS`). Tests for adapter path/format and registry, and init test that DevAgent gets command files.
- **APIs**: None. Adapter conforms to existing `ToolCommandAdapter` interface.
- **Dependencies**: None.
