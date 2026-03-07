/**
 * Command Reference Utilities
 *
 * Utilities for transforming command references to tool-specific formats.
 */

/**
 * Transforms colon-based command references to hyphen-based format.
 * Converts `/infra:` patterns to `/infra-` for tools that use hyphen syntax.
 *
 * @param text - The text containing command references
 * @returns Text with command references transformed to hyphen format
 *
 * @example
 * transformToHyphenCommands('/infra:new') // returns '/infra-new'
 * transformToHyphenCommands('Use /infra:apply to implement') // returns 'Use /infra-apply to implement'
 */
export function transformToHyphenCommands(text: string): string {
  return text.replace(/\/infra:/g, '/infra-');
}
