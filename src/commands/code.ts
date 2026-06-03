import type { Command } from 'commander';
import ora from 'ora';
import { analyzeCodeForChange, indexProjectCode } from '../core/infra-code/analyze.js';
import { getCodeModuleDetail, listCodeModules } from '../core/infra-code/query.js';

interface AnalyzeOptions {
  change?: string;
  json?: boolean;
  maxNodes?: string;
  maxCode?: string;
}

interface ModuleDetailOptions {
  json?: boolean;
  refresh?: boolean;
  maxFiles?: string;
  maxSymbols?: string;
  maxFlows?: string;
  maxEdges?: string;
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
    .command('index')
    .description('Generate the global code graph index for the current project')
    .option('--json', 'Output result as JSON')
    .action(async (options: { json?: boolean }) => {
      const spinner = options.json
        ? null
        : ora('Indexing project code...').start();

      try {
        const result = await indexProjectCode();

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          spinner?.succeed(`Generated code graph index at ${result.indexPath}`);
        }
      } catch (error) {
        if (spinner) {
          spinner.fail(`Code indexing failed: ${(error as Error).message}`);
        } else {
          console.error(`Error: ${(error as Error).message}`);
        }
        process.exit(1);
      }
    });

  code
    .command('modules')
    .description('List code modules from the global code graph index')
    .option('--json', 'Output result as JSON')
    .option('--refresh', 'Rebuild the global code graph index before listing modules')
    .action(async (options: { json?: boolean; refresh?: boolean }) => {
      const spinner = options.json
        ? null
        : ora(options.refresh ? 'Refreshing code modules...' : 'Loading code modules...').start();

      try {
        const result = await listCodeModules({ refresh: options.refresh });

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          spinner?.succeed(`Found ${result.modules.length} code modules`);
          for (const module of result.modules) {
            console.log(`- ${module.id} (${module.fileCount} files, ${module.symbolCount} symbols, ${module.confidence})`);
          }
        }
      } catch (error) {
        if (spinner) {
          spinner.fail(`Code module listing failed: ${(error as Error).message}`);
        } else {
          console.error(`Error: ${(error as Error).message}`);
        }
        process.exit(1);
      }
    });

  code
    .command('module <id>')
    .description('Show a context-sized slice for one code module')
    .option('--json', 'Output result as JSON')
    .option('--refresh', 'Rebuild the global code graph index before reading the module')
    .option('--max-files <number>', 'Maximum files to include', '80')
    .option('--max-symbols <number>', 'Maximum symbols to include', '160')
    .option('--max-flows <number>', 'Maximum execution flows to include', '20')
    .option('--max-edges <number>', 'Maximum graph edges to include', '240')
    .action(async (id: string, options: ModuleDetailOptions) => {
      const spinner = options.json
        ? null
        : ora(`Loading code module '${id}'...`).start();

      try {
        const result = await getCodeModuleDetail({
          moduleId: id,
          refresh: options.refresh,
          maxFiles: parsePositiveInteger(options.maxFiles, '--max-files'),
          maxSymbols: parsePositiveInteger(options.maxSymbols, '--max-symbols'),
          maxFlows: parsePositiveInteger(options.maxFlows, '--max-flows'),
          maxEdges: parsePositiveInteger(options.maxEdges, '--max-edges'),
        });

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          spinner?.succeed(`Loaded module '${result.module.id}'`);
          console.log(`Files: ${result.totals.files}${result.truncated.files ? ` (showing ${result.files.length})` : ''}`);
          console.log(`Symbols: ${result.totals.symbols}${result.truncated.symbols ? ` (showing ${result.symbols.length})` : ''}`);
          console.log(`Entry points: ${result.totals.entryPoints}`);
          console.log(`Execution flows: ${result.totals.executionFlows}${result.truncated.executionFlows ? ` (showing ${result.executionFlows.length})` : ''}`);
        }
      } catch (error) {
        if (spinner) {
          spinner.fail(`Code module loading failed: ${(error as Error).message}`);
        } else {
          console.error(`Error: ${(error as Error).message}`);
        }
        process.exit(1);
      }
    });

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
