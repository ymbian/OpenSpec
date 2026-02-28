## ADDED Requirements

### Requirement: Legacy DevAgent workflow detection

The system SHALL treat DevAgent workflow files under `.devagentrules/workflows/` as legacy slash-command artifacts when detecting and cleaning up legacy OpenSpec artifacts.

#### Scenario: Detecting legacy DevAgent workflow files

- **WHEN** running `openspec init` or legacy cleanup on an existing project
- **THEN** the system SHALL check for legacy workflow files matching `.devagentrules/workflows/openspec-*.md`
- **AND** SHALL include such files in legacy slash-command detection and cleanup (same behavior as Cline’s `.clinerules/workflows/openspec-*.md`)
