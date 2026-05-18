import type { Command } from 'commander';
import ora from 'ora';
import { analyzeCodeForChange } from '../core/infra-code/analyze.js';

interface AnalyzeOptions {
  change?: string;
  json?: boolean;
  maxNodes?: string;
  maxCode?: string;
}

function parsePositiveInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export function registerCodeCommand(program: Command): void {
  const code = program
    .command('code')
    .description('Analyze project code for InfraSpec workflows');

  code
    .command('analyze')
    .description('Generate code-context files for a change from requirement-description.md')
    .requiredOption('--change <name>', 'Change name to analyze')
    .option('--json', 'Output result as JSON')
    .option('--max-nodes <number>', 'Maximum code graph nodes to include', '30')
    .option('--max-code <number>', 'Maximum code blocks to include', '8')
    .action(async (options: AnalyzeOptions) => {
      const spinner = options.json
        ? null
        : ora(`Analyzing code context for '${options.change}'...`).start();

      try {
        const result = await analyzeCodeForChange({
          change: options.change ?? '',
          maxNodes: parsePositiveInteger(options.maxNodes, '--max-nodes'),
          maxCodeBlocks: parsePositiveInteger(options.maxCode, '--max-code'),
        });

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (result.status === 'ready') {
          spinner?.succeed(`Generated code context at ${result.contextPath}`);
        } else {
          spinner?.warn(result.message);
          if (result.error) {
            console.log(result.error);
          }
        }
      } catch (error) {
        if (spinner) {
          spinner.fail(`Code analysis failed: ${(error as Error).message}`);
        } else {
          console.error(`Error: ${(error as Error).message}`);
        }
        process.exit(1);
      }
    });
}
