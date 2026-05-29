import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  type CodeBlock,
  type CodeContext,
  type CodeEdge,
  type CodeFile,
  type CodeSymbol,
  type InfraCodeIndex,
  type ScoredFile,
  type ScoredSymbol,
} from './types.js';
import { expandRequirementTerms, uniqueTerms } from './text.js';

export interface BuildCodeContextOptions {
  maxNodes?: number;
  maxCodeBlocks?: number;
  maxCodeBlockSize?: number;
}

const DEFAULT_MAX_NODES = 30;
const DEFAULT_MAX_CODE_BLOCKS = 8;
const DEFAULT_MAX_CODE_BLOCK_SIZE = 1600;

function isTestFile(filePath: string): boolean {
  return /(^|\/)(__tests__|tests?|spec|e2e)\//u.test(filePath)
    || /\.(test|spec)\.[A-Za-z0-9]+$/u.test(filePath);
}

function hasChinese(value: string): boolean {
  return /[\u4e00-\u9fff]/u.test(value);
}

function scoreTermAgainstText(term: string, text: string, exactBoost: number, containsBoost: number): number {
  if (!term) return 0;
  if (text === term) return exactBoost;
  if (text.includes(term)) return containsBoost;
  return 0;
}

function scoreSymbol(symbol: CodeSymbol, file: CodeFile | undefined, terms: string[], query: string): ScoredSymbol | null {
  const matchedTerms = new Set<string>();
  const reasons = new Set<string>();
  let score = 0;
  const nameLower = symbol.name.toLowerCase();
  const signatureLower = symbol.signature?.toLowerCase() ?? '';
  const filePathLower = symbol.filePath.toLowerCase();
  const symbolTerms = new Set(symbol.terms);
  const fileTerms = new Set(file?.terms ?? []);

  for (const term of terms) {
    const lowerTerm = term.toLowerCase();
    const nameScore = scoreTermAgainstText(lowerTerm, nameLower, 100, 60);
    if (nameScore > 0) {
      score += nameScore;
      matchedTerms.add(term);
      reasons.add(nameScore >= 100 ? 'symbol name exact match' : 'symbol name contains term');
    }

    if (symbolTerms.has(lowerTerm)) {
      score += 35;
      matchedTerms.add(term);
      reasons.add('symbol token match');
    }

    if (fileTerms.has(lowerTerm)) {
      score += 18;
      matchedTerms.add(term);
      reasons.add('file token match');
    }

    if (filePathLower.includes(lowerTerm)) {
      score += 25;
      matchedTerms.add(term);
      reasons.add('file path match');
    }

    if (signatureLower.includes(lowerTerm)) {
      score += 12;
      matchedTerms.add(term);
      reasons.add('signature match');
    }
  }

  if (matchedTerms.size >= 2) {
    score *= 1 + Math.min(0.8, matchedTerms.size * 0.12);
  }

  if (symbol.exported) score += 6;
  if ((symbol.kind === 'function' || symbol.kind === 'method' || symbol.kind === 'class' || symbol.kind === 'component') && score > 0) {
    score += 8;
  }

  const queryMentionsTest = /\b(test|spec|e2e)\b/i.test(query) || query.includes('测试');
  if (!queryMentionsTest && isTestFile(symbol.filePath)) {
    score *= 0.35;
  }

  if (score <= 0) return null;

  return {
    symbol,
    score: Math.round(score * 100) / 100,
    matchedTerms: [...matchedTerms],
    reasons: [...reasons],
  };
}

function scoreFile(file: CodeFile, terms: string[], query: string): ScoredFile | null {
  const matchedTerms = new Set<string>();
  let score = 0;
  const pathLower = file.path.toLowerCase();
  const fileTerms = new Set(file.terms);

  for (const term of terms) {
    const lowerTerm = term.toLowerCase();
    if (fileTerms.has(lowerTerm)) {
      score += 25;
      matchedTerms.add(term);
    }
    if (pathLower.includes(lowerTerm)) {
      score += 35;
      matchedTerms.add(term);
    }
  }

  if (matchedTerms.size >= 2) {
    score *= 1 + Math.min(0.6, matchedTerms.size * 0.1);
  }

  const queryMentionsTest = /\b(test|spec|e2e)\b/i.test(query) || query.includes('测试');
  if (!queryMentionsTest && isTestFile(file.path)) {
    score *= 0.35;
  }

  if (score <= 0) return null;
  return {
    file,
    score: Math.round(score * 100) / 100,
    matchedTerms: [...matchedTerms],
  };
}

function mergeScoredSymbol(existing: ScoredSymbol | undefined, next: ScoredSymbol): ScoredSymbol {
  if (!existing) return next;
  return {
    symbol: existing.symbol,
    score: Math.max(existing.score, next.score),
    matchedTerms: uniqueTerms([...existing.matchedTerms, ...next.matchedTerms]),
    reasons: uniqueTerms([...existing.reasons, ...next.reasons]),
  };
}

function pickSymbolsFromRelevantFiles(
  files: ScoredFile[],
  symbols: CodeSymbol[],
  existingIds: Set<string>,
  limit: number
): ScoredSymbol[] {
  const fileScores = new Map(files.map((file) => [file.file.path, file.score]));
  return symbols
    .filter((symbol) => !existingIds.has(symbol.id) && fileScores.has(symbol.filePath))
    .map((symbol) => ({
      symbol,
      score: Math.max(1, (fileScores.get(symbol.filePath) ?? 0) * 0.45),
      matchedTerms: [],
      reasons: ['symbol from relevant file'],
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function collectRelatedSymbols(
  index: InfraCodeIndex,
  selected: ScoredSymbol[],
  maxNodes: number
): { symbols: ScoredSymbol[]; edges: CodeEdge[] } {
  const selectedIds = new Set(selected.map((item) => item.symbol.id));
  const byId = new Map(index.symbols.map((symbol) => [symbol.id, symbol]));
  const related = new Map<string, ScoredSymbol>();
  const relatedEdges: CodeEdge[] = [];

  for (const edge of index.edges) {
    const sourceSelected = selectedIds.has(edge.source);
    const targetSelected = selectedIds.has(edge.target);
    if (!sourceSelected && !targetSelected) continue;
    if (edge.kind !== 'calls' && edge.kind !== 'references') continue;

    relatedEdges.push(edge);
    const neighborId = sourceSelected ? edge.target : edge.source;
    if (selectedIds.has(neighborId)) continue;
    const symbol = byId.get(neighborId);
    if (!symbol) continue;

    const directionBonus = targetSelected ? 18 : 12;
    const confidenceBonus = edge.confidence === 'high' ? 8 : edge.confidence === 'medium' ? 4 : 1;
    const next: ScoredSymbol = {
      symbol,
      score: directionBonus + confidenceBonus,
      matchedTerms: [],
      reasons: [targetSelected ? 'caller of entry symbol' : 'called by entry symbol'],
    };
    related.set(neighborId, mergeScoredSymbol(related.get(neighborId), next));
  }

  return {
    symbols: [...related.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.max(0, maxNodes - selected.length)),
    edges: relatedEdges,
  };
}

async function extractCodeBlock(projectRoot: string, symbol: CodeSymbol, maxSize: number): Promise<CodeBlock | null> {
  const absolutePath = path.join(projectRoot, symbol.filePath);
  try {
    const content = await fs.readFile(absolutePath, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, symbol.startLine - 1);
    const end = Math.min(lines.length, symbol.endLine);
    const raw = lines.slice(start, end).join('\n');
    const truncated = raw.length > maxSize ? `${raw.slice(0, maxSize)}\n// ... truncated ...` : raw;
    return {
      symbol,
      filePath: symbol.filePath,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      language: symbol.language,
      content: truncated,
    };
  } catch {
    return null;
  }
}

function buildRelevantFiles(
  files: ScoredFile[],
  selectedSymbols: ScoredSymbol[],
  relatedSymbols: ScoredSymbol[],
  fileByPath: Map<string, CodeFile>
): ScoredFile[] {
  const fileMap = new Map(files.map((item) => [item.file.path, item]));
  for (const item of [...selectedSymbols, ...relatedSymbols]) {
    const file = fileByPath.get(item.symbol.filePath);
    if (!file) continue;
    const existing = fileMap.get(file.path);
    const nextScore = Math.max(existing?.score ?? 0, item.score * 0.55);
    fileMap.set(file.path, {
      file,
      score: Math.round(nextScore * 100) / 100,
      matchedTerms: existing?.matchedTerms ?? item.matchedTerms,
    });
  }

  return [...fileMap.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, 12);
}

function uniquePreserve(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export async function buildCodeContext(
  projectRoot: string,
  index: InfraCodeIndex,
  requirement: string,
  options: BuildCodeContextOptions = {}
): Promise<CodeContext> {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxCodeBlocks = options.maxCodeBlocks ?? DEFAULT_MAX_CODE_BLOCKS;
  const maxCodeBlockSize = options.maxCodeBlockSize ?? DEFAULT_MAX_CODE_BLOCK_SIZE;
  const expandedTerms = expandRequirementTerms(requirement);
  const fileByPath = new Map(index.files.map((file) => [file.path, file]));

  const scoredSymbols = index.symbols
    .map((symbol) => scoreSymbol(symbol, fileByPath.get(symbol.filePath), expandedTerms, requirement))
    .filter((item): item is ScoredSymbol => item !== null)
    .sort((left, right) => right.score - left.score);

  const scoredFiles = index.files
    .map((file) => scoreFile(file, expandedTerms, requirement))
    .filter((item): item is ScoredFile => item !== null)
    .sort((left, right) => right.score - left.score);

  const entryLimit = Math.max(4, Math.min(12, Math.ceil(maxNodes * 0.4)));
  let entrySymbols = scoredSymbols.slice(0, entryLimit);

  if (entrySymbols.length === 0 && scoredFiles.length > 0) {
    entrySymbols = pickSymbolsFromRelevantFiles(scoredFiles, index.symbols, new Set(), entryLimit);
  }

  const selectedIds = new Set(entrySymbols.map((item) => item.symbol.id));
  const related = collectRelatedSymbols(index, entrySymbols, maxNodes);
  const relatedSymbols = [
    ...related.symbols,
    ...pickSymbolsFromRelevantFiles(scoredFiles, index.symbols, selectedIds, Math.max(0, maxNodes - entrySymbols.length - related.symbols.length)),
  ]
    .filter((item) => !selectedIds.has(item.symbol.id))
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(0, maxNodes - entrySymbols.length));

  const relevantFiles = buildRelevantFiles(scoredFiles, entrySymbols, relatedSymbols, fileByPath);

  const codeBlocks: CodeBlock[] = [];
  const blockCandidates = [...entrySymbols, ...relatedSymbols]
    .filter((item) => ['function', 'method', 'class', 'component'].includes(item.symbol.kind));
  const blockSeen = new Set<string>();
  for (const item of blockCandidates) {
    if (codeBlocks.length >= maxCodeBlocks) break;
    if (blockSeen.has(item.symbol.id)) continue;
    const block = await extractCodeBlock(projectRoot, item.symbol, maxCodeBlockSize);
    if (block) {
      codeBlocks.push(block);
      blockSeen.add(item.symbol.id);
    }
  }

  const impactFiles = uniquePreserve([
    ...entrySymbols.map((item) => item.symbol.filePath),
    ...relatedSymbols.map((item) => item.symbol.filePath),
    ...relevantFiles.slice(0, 6).map((item) => item.file.path),
  ]);
  const impactSymbols = [...new Set(relatedSymbols.slice(0, 10).map((item) => item.symbol.name))];

  const gaps: string[] = [];
  if (entrySymbols.length === 0) {
    gaps.push('No symbol-level match found; requirements should be grounded by manual inspection.');
  }
  if (hasChinese(requirement)) {
    gaps.push('Chinese requirement terms were expanded with a built-in technical dictionary; verify symbol matches manually.');
  }
  if (index.stats.skippedLargeFiles > 0) {
    gaps.push(`${index.stats.skippedLargeFiles} large files were skipped during code graph indexing.`);
  }
  if (index.stats.regexFallbackFiles > 0) {
    gaps.push(`${index.stats.regexFallbackFiles} files used regex fallback because tree-sitter could not provide AST results.`);
  }
  if (index.stats.parseErrors.length > 0) {
    gaps.push(`${index.stats.parseErrors.length} parser warnings were recorded; inspect infraspec/.code-graph/index.json for details.`);
  }

  return {
    query: requirement,
    expandedTerms,
    entrySymbols,
    relatedSymbols,
    relevantFiles,
    relatedEdges: related.edges,
    codeBlocks,
    impact: {
      files: impactFiles,
      symbols: impactSymbols,
    },
    gaps,
    stats: {
      indexedFiles: index.stats.fileCount,
      indexedSymbols: index.stats.symbolCount,
      indexedEdges: index.stats.edgeCount,
      entrySymbolCount: entrySymbols.length,
      relevantFileCount: relevantFiles.length,
      codeBlockCount: codeBlocks.length,
      parserBackend: index.stats.parserBackend,
      treeSitterFiles: index.stats.treeSitterFiles,
      regexFallbackFiles: index.stats.regexFallbackFiles,
    },
  };
}

function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

export function formatCodeContextMarkdown(context: CodeContext, requirementPath: string, indexPath: string): string {
  const lines: string[] = [
    '# Code Context',
    '',
    `Requirement source: \`${requirementPath}\``,
    `Index source: \`${indexPath}\``,
    '',
    'This file is generated by `infraspec code analyze` using InfraSpec\'s built-in tree-sitter code graph.',
    '',
    '## Summary',
    '',
    `Found ${context.entrySymbols.length} entry symbols and ${context.relevantFiles.length} relevant files from ${context.stats.indexedFiles} indexed files.`,
    `Parser backend: \`${context.stats.parserBackend}\` (${context.stats.treeSitterFiles} tree-sitter files, ${context.stats.regexFallbackFiles} regex fallback files).`,
    '',
    '## Expanded Query Terms',
    '',
    context.expandedTerms.length > 0 ? context.expandedTerms.map((term) => `- \`${term}\``).join('\n') : '- None',
    '',
    '## Relevant Files',
    '',
  ];

  if (context.relevantFiles.length === 0) {
    lines.push('- No relevant files found.');
  } else {
    for (const item of context.relevantFiles) {
      lines.push(`- \`${item.file.path}\` (${item.file.language}, score ${formatScore(item.score)})`);
    }
  }

  lines.push('', '## Entry Symbols', '');
  if (context.entrySymbols.length === 0) {
    lines.push('- No entry symbols found.');
  } else {
    for (const item of context.entrySymbols) {
      const signature = item.symbol.signature ? ` - \`${item.symbol.signature}\`` : '';
      lines.push(`- **${item.symbol.name}** (${item.symbol.kind}) - \`${item.symbol.filePath}:${item.symbol.startLine}\` - score ${formatScore(item.score)}${signature}`);
      if (item.matchedTerms.length > 0) {
        lines.push(`  matched: ${item.matchedTerms.map((term) => `\`${term}\``).join(', ')}`);
      }
    }
  }

  lines.push('', '## Related Symbols', '');
  if (context.relatedSymbols.length === 0) {
    lines.push('- No related symbols found from code graph expansion.');
  } else {
    for (const item of context.relatedSymbols.slice(0, 12)) {
      lines.push(`- **${item.symbol.name}** (${item.symbol.kind}) - \`${item.symbol.filePath}:${item.symbol.startLine}\` - ${item.reasons.join(', ')}`);
    }
  }

  lines.push('', '## Related Code', '');
  if (context.codeBlocks.length === 0) {
    lines.push('- No code blocks extracted.');
  } else {
    for (const block of context.codeBlocks) {
      lines.push(`### ${block.symbol.name} (${block.filePath}:${block.startLine})`, '');
      lines.push(`\`\`\`${block.language}`);
      lines.push(block.content);
      lines.push('```', '');
    }
  }

  lines.push('## Potential Impact', '');
  if (context.impact.files.length === 0) {
    lines.push('- No impact files inferred.');
  } else {
    for (const file of context.impact.files.slice(0, 12)) {
      lines.push(`- \`${file}\``);
    }
  }

  lines.push('', '## Confidence And Gaps', '');
  if (context.gaps.length === 0) {
    lines.push('- Lightweight code graph analysis completed without known gaps.');
  } else {
    for (const gap of context.gaps) {
      lines.push(`- ${gap}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}
