/**
 * Profile System
 *
 * Defines workflow profiles that control which workflows are installed.
 * Profiles determine WHICH workflows; delivery (in global config) determines HOW.
 */

import type { Profile } from './global-config.js';

/**
 * Core workflows included in the 'core' profile.
 * These provide the streamlined experience for new users.
 */
export const CORE_WORKFLOWS = ['propose', 'explore', 'new', 'continue', 'review', 'apply', 'archive'] as const;

/**
 * Legacy core workflows from before the review alias was introduced.
 * Keep this for backward compatibility with migrated custom profiles.
 */
const LEGACY_CORE_WORKFLOWS = ['propose', 'explore', 'new', 'continue', 'apply', 'archive'] as const;

/**
 * All available workflows in the system.
 */
export const ALL_WORKFLOWS = [
  'propose',
  'explore',
  'new',
  'continue',
  'review',
  'apply',
  'ff',
  'sync',
  'archive',
  'bulk-archive',
  'verify',
  'onboard',
] as const;

export type WorkflowId = (typeof ALL_WORKFLOWS)[number];
export type CoreWorkflowId = (typeof CORE_WORKFLOWS)[number];

function normalizeCustomWorkflows(customWorkflows?: string[]): readonly string[] {
  if (!customWorkflows) {
    return [];
  }

  const uniqueWorkflows = [...new Set(customWorkflows)];
  const isLegacyCoreSet =
    uniqueWorkflows.length === LEGACY_CORE_WORKFLOWS.length &&
    LEGACY_CORE_WORKFLOWS.every((workflow) => uniqueWorkflows.includes(workflow));

  if (isLegacyCoreSet) {
    return CORE_WORKFLOWS;
  }

  return uniqueWorkflows;
}

/**
 * Resolves which workflows should be active for a given profile configuration.
 *
 * - 'core' profile always returns CORE_WORKFLOWS
 * - 'custom' profile returns the provided customWorkflows, or empty array if not provided
 */
export function getProfileWorkflows(
  profile: Profile,
  customWorkflows?: string[]
): readonly string[] {
  if (profile === 'custom') {
    return normalizeCustomWorkflows(customWorkflows);
  }
  return CORE_WORKFLOWS;
}
