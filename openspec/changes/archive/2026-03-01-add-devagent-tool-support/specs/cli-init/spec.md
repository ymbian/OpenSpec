## ADDED Requirements

### Requirement: DevAgent is a selectable tool

The init and update flows SHALL include DevAgent in the set of selectable AI tools when it is defined in the supported tools configuration, and SHALL accept `devagent` as a valid tool ID for non-interactive configuration.

#### Scenario: DevAgent appears in Select tools list

- **WHEN** the user runs `openspec init` or `openspec update` and the tool selection step is shown
- **THEN** the multi-select SHALL include an option for DevAgent (e.g. "DevAgent")
- **AND** the user SHALL be able to select it to configure skills and commands for DevAgent

#### Scenario: Non-interactive init with DevAgent

- **WHEN** the user runs `openspec init --tools devagent`
- **THEN** the command SHALL accept `devagent` as a valid tool ID
- **AND** SHALL generate skills under `.devagent/skills/` and commands under `.devagent/commands/` (or the configured `skillsDir` for the devagent tool)
- **AND** SHALL exit with code 0 when generation succeeds

#### Scenario: DevAgent detected when directory present

- **WHEN** the project root contains a `.devagent` directory (or the configured skillsDir for devagent)
- **AND** the user runs init or update
- **THEN** DevAgent SHALL be included in the set of available tools for selection or display (e.g. as "detected" or in the list of configured tools)
