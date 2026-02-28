## Context

OpenSpec already has DevAgent in `AI_TOOLS` with `skillsDir: '.devagent'` (skills go to `.devagent/skills/`). There is no command adapter for DevAgent, so init/update skip command generation for that tool and users see "Commands skipped for: devagent (no adapter)". Cline uses a separate rules path: skills in `.cline/skills/`, workflow files in `.clinerules/workflows/opsx-<id>.md` with Markdown header format. DevAgent mirrors Cline but uses `.devagent` and `.devagentrules`. The adapter registry and init/update already support any registered adapter; adding a DevAgent adapter that mirrors Cline (path `.devagentrules/workflows/`, same format) gives full parity. Legacy cleanup uses `LEGACY_SLASH_COMMAND_PATHS`; adding a `devagent` entry ensures future upgrades detect old `.devagentrules/workflows/openspec-*.md` files.

## Goals / Non-Goals

**Goals:**

- DevAgent gets workflow command files generated under `.devagentrules/workflows/opsx-<id>.md` when selected in init/update, using the same Markdown format as Cline (name header, description, body). No Cline-specific logic in init—reuse the same adapter pattern.
- Legacy cleanup can detect and remove/upgrade legacy DevAgent workflow files (`.devagentrules/workflows/openspec-*.md`).

**Non-Goals:**

- Changing `.devagent` or skill paths; no new config keys or CLI flags; no change to Cline adapter itself.

## Decisions

1. **New adapter file `devagent.ts` mirroring Cline**
   - **Choice**: Implement `devagentAdapter` with `toolId: 'devagent'`, `getFilePath` → `.devagentrules/workflows/opsx-<id>.md`, `formatFile` identical to Cline (Markdown `# name`, description, body). Register in registry and export from adapters index.
   - **Rationale**: Single place for DevAgent path/format; init and update already use `CommandAdapterRegistry.get(toolId)` and generate commands when adapter exists. No branching in init.
   - **Alternative**: Reuse Cline adapter with a path override per tool. Rejected to keep adapters one-per-tool and avoid config complexity.

2. **Legacy pattern for DevAgent**
   - **Choice**: Add `'devagent': { type: 'files', pattern: '.devagentrules/workflows/openspec-*.md' }` to `LEGACY_SLASH_COMMAND_PATHS` in `legacy-cleanup.ts`. Legacy detection and cleanup then treat DevAgent like Cline (file-based pattern).
   - **Rationale**: Matches Cline’s pattern shape; ensures upgrade path for users who previously had openspec-*.md under .devagentrules.

## Risks / Trade-offs

- **[Risk]** DevAgent might later diverge from Cline (e.g. different file naming). **[Mitigation]** Document that the adapter is Cline-compatible; if DevAgent changes, we add a separate format in a follow-up.
- **[Risk]** `.devagentrules` vs `.devagent/rules` or similar. **[Mitigation]** User stated `.devagentrules`; we use that. If official docs differ, adjust in a patch.

## Migration Plan

- No migration. New adapter and legacy entry are additive. Existing DevAgent users who only had skills will get commands on next init/update with DevAgent selected.

## Open Questions

- None.
