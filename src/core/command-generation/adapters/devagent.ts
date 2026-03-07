/**
 * DevAgent Command Adapter
 *
 * DevAgent is Cline-based; uses the same workflow format as Cline but with
 * .devagentrules instead of .clinerules and .devagent instead of .cline.
 */

import path from 'path';
import type { CommandContent, ToolCommandAdapter } from '../types.js';

/**
 * DevAgent adapter for command generation.
 * File path: .devagentrules/workflows/infra-<id>.md
 * Format: Markdown header with description (same as Cline)
 */
export const devagentAdapter: ToolCommandAdapter = {
  toolId: 'devagent',

  getFilePath(commandId: string): string {
    return path.join('.devagentrules', 'workflows', `infra-${commandId}.md`);
  },

  formatFile(content: CommandContent): string {
    return `# ${content.name}

${content.description}

${content.body}
`;
  },
};
