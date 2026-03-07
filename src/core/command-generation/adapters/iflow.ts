/**
 * iFlow Command Adapter
 *
 * Formats commands for iFlow following its frontmatter specification.
 */

import path from 'path';
import type { CommandContent, ToolCommandAdapter } from '../types.js';

/**
 * iFlow adapter for command generation.
 * File path: .iflow/commands/infra-<id>.md
 * Frontmatter: name, id, category, description
 */
export const iflowAdapter: ToolCommandAdapter = {
  toolId: 'iflow',

  getFilePath(commandId: string): string {
    return path.join('.iflow', 'commands', `infra-${commandId}.md`);
  },

  formatFile(content: CommandContent): string {
    return `---
name: /infra-${content.id}
id: infra-${content.id}
category: ${content.category}
description: ${content.description}
---

${content.body}
`;
  },
};
