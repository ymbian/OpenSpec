## ADDED Requirements

### Requirement: DevAgent adapter (Cline-compatible format and path)

The system SHALL provide a command adapter for DevAgent that uses the same workflow file format as Cline (Markdown header, description, body) and writes to `.devagentrules/workflows/`.

#### Scenario: DevAgent adapter formatting

- **WHEN** formatting a command for DevAgent
- **THEN** the adapter SHALL output Markdown with a level-one header for the command name, then description, then body (same structure as the Cline adapter)
- **AND** file path SHALL follow pattern `.devagentrules/workflows/opsx-<id>.md` (using `path.join()` for cross-platform paths)

#### Scenario: Get adapter for DevAgent

- **WHEN** calling `CommandAdapterRegistry.get('devagent')`
- **THEN** it SHALL return the DevAgent adapter or undefined if not registered
