import type { ProjectConfig } from './project-config.js';

/**
 * Serialize config to YAML string with helpful comments.
 *
 * @param config - Partial config object (schema required, context/rules optional)
 * @returns YAML string ready to write to file
 */
export function serializeConfig(config: Partial<ProjectConfig>): string {
  const lines: string[] = [];

  // Schema (required)
  lines.push(`schema: ${config.schema}`);
  lines.push('');

  // Context section with comments
  lines.push('# Project context (optional)');
  lines.push('# This is shown to AI when creating artifacts.');
  lines.push('# Add your tech stack, conventions, style guides, domain knowledge, etc.');
  lines.push('# Example:');
  lines.push('#   context: |');
  lines.push('#     Tech stack: TypeScript, React, Node.js');
  lines.push('#     We use conventional commits');
  lines.push('#     Domain: e-commerce platform');
  lines.push('');

  if (config.context && config.context.trim().length > 0) {
    lines.push('context: |');
    for (const line of config.context.trimEnd().split('\n')) {
      lines.push(`  ${line}`);
    }
    lines.push('');
  }

  // Business knowledge section with comments
  lines.push('# Business knowledge base (optional, used by /infra:explore and /infra:biz)');
  lines.push('# Fill this when brainstorming or business requirement writing should query the company knowledge base.');
  lines.push('# Example:');
  lines.push('#   businessKnowledge:');
  lines.push('#     productId: S20250528171525987134');
  lines.push('#     botId: "3467"');

  if (config.businessKnowledge) {
    lines.push('');
    lines.push('businessKnowledge:');
    lines.push(`  productId: ${config.businessKnowledge.productId}`);
    lines.push(`  botId: "${config.businessKnowledge.botId}"`);
  }

  // Rules section with comments
  lines.push('');
  lines.push('# Per-artifact rules (optional)');
  lines.push('# Add custom rules for specific artifacts.');
  lines.push('# Example:');
  lines.push('#   rules:');
  lines.push('#     proposal:');
  lines.push('#       - Keep proposals under 500 words');
  lines.push('#       - Always include a "Non-goals" section');
  lines.push('#     tasks:');
  lines.push('#       - Break tasks into chunks of max 2 hours');

  if (config.rules && Object.keys(config.rules).length > 0) {
    lines.push('');
    lines.push('rules:');
    for (const [artifactId, rules] of Object.entries(config.rules)) {
      lines.push(`  ${artifactId}:`);
      for (const rule of rules) {
        lines.push(`    - ${rule}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}
