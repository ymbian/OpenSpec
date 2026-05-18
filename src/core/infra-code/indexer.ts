import { createHash } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import fg from 'fast-glob';
import {
  INFRA_CODE_INDEX_VERSION,
  type CodeEdge,
  type CodeFile,
  type CodeLanguage,
  type CodeSymbol,
  type CodeSymbolKind,
  type InfraCodeIndex,
} from './types.js';
import { termsFromPath, termsFromSymbol, uniqueTerms } from './text.js';

export const INFRA_CODE_DIR = path.join('infraspec', '.code-graph');
export const INFRA_CODE_INDEX_FILE = 'index.json';

const MAX_FILE_SIZE_BYTES = 750 * 1024;
const MAX_CALL_EDGES = 8000;

const SOURCE_PATTERNS = [
  '**/*.{ts,tsx,js,jsx,mjs,cjs,py,java,go,rs,svelte,vue}',
];

const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.turbo/**',
  '**/.cache/**',
  '**/.codegraph/**',
  '**/infraspec/**',
  '**/.cline/**',
  '**/.claude/**',
  '**/.cursor/**',
  '**/.roo/**',
];

const CONTROL_CALLS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'sizeof',
  'new', 'super', 'await', 'yield', 'function',
]);

function toPosix(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function fileId(filePath: string): string {
  return `file:${filePath}`;
}

function symbolId(filePath: string, name: string, startLine: number): string {
  return `symbol:${filePath}:${startLine}:${name}`;
}

function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

function detectLanguage(filePath: string): CodeLanguage {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.py':
      return 'python';
    case '.java':
      return 'java';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.svelte':
      return 'svelte';
    case '.vue':
      return 'vue';
    default:
      return 'unknown';
  }
}

function extractImports(content: string, language: CodeLanguage): string[] {
  const imports = new Set<string>();
  const patterns = [
    /\bimport\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  if (language === 'python') {
    patterns.push(/^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+/gm);
    patterns.push(/^\s*import\s+([A-Za-z0-9_.]+)/gm);
  }

  if (language === 'go') {
    patterns.push(/^\s*import\s+['"]([^'"]+)['"]/gm);
  }

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const value = match[1]?.trim();
      if (value) imports.add(value);
    }
  }

  return [...imports].sort();
}

function findEndLine(lines: string[], startIndex: number): number {
  let depth = 0;
  let sawBrace = false;
  const maxIndex = Math.min(lines.length - 1, startIndex + 300);

  for (let i = startIndex; i <= maxIndex; i++) {
    for (const char of lines[i] ?? '') {
      if (char === '{') {
        depth++;
        sawBrace = true;
      } else if (char === '}') {
        depth--;
      }
    }

    if (sawBrace && depth <= 0) {
      return i + 1;
    }
  }

  if (!sawBrace) return startIndex + 1;
  return Math.min(lines.length, startIndex + 80);
}

function makeSymbol(
  filePath: string,
  language: CodeLanguage,
  lines: string[],
  lineIndex: number,
  kind: CodeSymbolKind,
  name: string,
  exported: boolean,
  signature: string
): CodeSymbol {
  const startLine = lineIndex + 1;
  const endLine = findEndLine(lines, lineIndex);
  return {
    id: symbolId(filePath, name, startLine),
    name,
    kind,
    filePath,
    language,
    startLine,
    endLine,
    signature: signature.trim().slice(0, 240),
    exported,
    terms: termsFromSymbol(name, signature),
  };
}

function isInsideRange(lineNumber: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => lineNumber > range.start && lineNumber <= range.end);
}

function extractTypeScriptSymbols(filePath: string, language: CodeLanguage, lines: string[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const classRanges: Array<{ start: number; end: number }> = [];

  lines.forEach((line, index) => {
    const classMatch = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (classMatch?.[1]) {
      const symbol = makeSymbol(filePath, language, lines, index, 'class', classMatch[1], line.includes('export'), line);
      symbols.push(symbol);
      classRanges.push({ start: symbol.startLine, end: symbol.endLine });
      return;
    }

    const interfaceMatch = line.match(/^\s*(?:export\s+)?(?:default\s+)?interface\s+([A-Za-z_$][\w$]*)/);
    if (interfaceMatch?.[1]) {
      symbols.push(makeSymbol(filePath, language, lines, index, 'interface', interfaceMatch[1], line.includes('export'), line));
      return;
    }

    const typeMatch = line.match(/^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/);
    if (typeMatch?.[1]) {
      symbols.push(makeSymbol(filePath, language, lines, index, 'type', typeMatch[1], line.includes('export'), line));
      return;
    }

    const enumMatch = line.match(/^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/);
    if (enumMatch?.[1]) {
      symbols.push(makeSymbol(filePath, language, lines, index, 'enum', enumMatch[1], line.includes('export'), line));
      return;
    }

    const functionMatch = line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (functionMatch?.[1]) {
      symbols.push(makeSymbol(filePath, language, lines, index, 'function', functionMatch[1], line.includes('export'), line));
      return;
    }

    const arrowMatch = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/);
    if (arrowMatch?.[1]) {
      symbols.push(makeSymbol(filePath, language, lines, index, 'function', arrowMatch[1], line.includes('export'), line));
      return;
    }

    const variableMatch = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (variableMatch?.[1]) {
      symbols.push(makeSymbol(filePath, language, lines, index, 'variable', variableMatch[1], line.includes('export'), line));
    }
  });

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (!isInsideRange(lineNumber, classRanges)) return;

    const methodMatch = line.match(/^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+|override\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:A-Za-z0-9_<>,[\]\s|.?]*\{/);
    const name = methodMatch?.[1];
    if (!name || CONTROL_CALLS.has(name)) return;
    symbols.push(makeSymbol(filePath, language, lines, index, 'method', name, line.includes('public'), line));
  });

  return symbols;
}

function extractSimpleSymbols(filePath: string, language: CodeLanguage, lines: string[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const patternsByLanguage: Record<CodeLanguage, Array<[CodeSymbolKind, RegExp]>> = {
    python: [
      ['class', /^\s*class\s+([A-Za-z_][\w]*)/],
      ['function', /^\s*def\s+([A-Za-z_][\w]*)\s*\(/],
    ],
    java: [
      ['class', /^\s*(?:public\s+|private\s+|protected\s+)?(?:abstract\s+)?class\s+([A-Za-z_][\w]*)/],
      ['interface', /^\s*(?:public\s+)?interface\s+([A-Za-z_][\w]*)/],
      ['method', /^\s*(?:public|private|protected)\s+(?:static\s+)?[A-Za-z_<>\[\], ?]+\s+([A-Za-z_][\w]*)\s*\(/],
    ],
    go: [
      ['function', /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/],
    ],
    rust: [
      ['function', /^\s*(?:pub\s+)?fn\s+([A-Za-z_][\w]*)\s*\(/],
      ['class', /^\s*(?:pub\s+)?struct\s+([A-Za-z_][\w]*)/],
      ['enum', /^\s*(?:pub\s+)?enum\s+([A-Za-z_][\w]*)/],
    ],
    svelte: [
      ['function', /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/],
      ['variable', /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/],
    ],
    vue: [
      ['function', /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/],
      ['variable', /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/],
    ],
    unknown: [],
    typescript: [],
    javascript: [],
  };
  const patterns = patternsByLanguage[language];

  lines.forEach((line, index) => {
    for (const [kind, pattern] of patterns) {
      const match = line.match(pattern);
      if (match?.[1]) {
        symbols.push(makeSymbol(filePath, language, lines, index, kind, match[1], line.includes('export') || line.includes('pub '), line));
        break;
      }
    }
  });

  return symbols;
}

function extractSymbols(filePath: string, language: CodeLanguage, content: string): CodeSymbol[] {
  const lines = content.split('\n');
  if (language === 'typescript' || language === 'javascript') {
    return extractTypeScriptSymbols(filePath, language, lines);
  }
  return extractSimpleSymbols(filePath, language, lines);
}

function resolveRelativeImport(sourceFilePath: string, importPath: string, filesByPath: Map<string, CodeFile>): string | undefined {
  if (!importPath.startsWith('.')) return undefined;

  const base = path.posix.normalize(path.posix.join(path.posix.dirname(sourceFilePath), importPath));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.svelte`,
    `${base}.vue`,
    path.posix.join(base, 'index.ts'),
    path.posix.join(base, 'index.tsx'),
    path.posix.join(base, 'index.js'),
    path.posix.join(base, 'index.jsx'),
  ];

  return candidates.find((candidate) => filesByPath.has(candidate));
}

function extractCallNames(content: string): Set<string> {
  const names = new Set<string>();
  const callPattern = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(content)) !== null) {
    const name = match[1];
    if (name && !CONTROL_CALLS.has(name)) {
      names.add(name);
    }
  }
  return names;
}

function buildEdges(files: CodeFile[], symbols: CodeSymbol[], contentsByPath: Map<string, string>): CodeEdge[] {
  const edges: CodeEdge[] = [];
  const edgeKeys = new Set<string>();
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const symbolsByName = new Map<string, CodeSymbol[]>();

  for (const symbol of symbols) {
    const list = symbolsByName.get(symbol.name) ?? [];
    list.push(symbol);
    symbolsByName.set(symbol.name, list);
  }

  const addEdge = (edge: CodeEdge) => {
    const key = `${edge.source}:${edge.target}:${edge.kind}`;
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      edges.push(edge);
    }
  };

  const importedFilesBySource = new Map<string, Set<string>>();
  for (const file of files) {
    const importedFiles = new Set<string>();
    for (const importPath of file.imports) {
      const targetPath = resolveRelativeImport(file.path, importPath, filesByPath);
      if (!targetPath) continue;
      importedFiles.add(targetPath);
      addEdge({
        source: file.id,
        target: fileId(targetPath),
        kind: 'imports',
        confidence: 'high',
      });
    }
    importedFilesBySource.set(file.path, importedFiles);
  }

  for (const source of symbols) {
    if (edges.length >= MAX_CALL_EDGES) break;
    const content = contentsByPath.get(source.filePath);
    if (!content) continue;
    const lines = content.split('\n');
    const symbolContent = lines.slice(source.startLine - 1, source.endLine).join('\n');
    const callNames = extractCallNames(symbolContent);
    const importedFiles = importedFilesBySource.get(source.filePath) ?? new Set<string>();

    for (const callName of callNames) {
      if (edges.length >= MAX_CALL_EDGES) break;
      const targets = symbolsByName.get(callName);
      if (!targets) continue;

      const rankedTargets = [...targets].sort((left, right) => {
        const leftScore = left.filePath === source.filePath ? 2 : importedFiles.has(left.filePath) ? 1 : 0;
        const rightScore = right.filePath === source.filePath ? 2 : importedFiles.has(right.filePath) ? 1 : 0;
        return rightScore - leftScore;
      });

      for (const target of rankedTargets.slice(0, 3)) {
        if (target.id === source.id) continue;
        addEdge({
          source: source.id,
          target: target.id,
          kind: 'calls',
          confidence: target.filePath === source.filePath ? 'high' : importedFiles.has(target.filePath) ? 'medium' : 'low',
        });
      }
    }
  }

  return edges;
}

export function getInfraCodeIndexDir(projectRoot: string): string {
  return path.join(projectRoot, INFRA_CODE_DIR);
}

export function getInfraCodeIndexPath(projectRoot: string): string {
  return path.join(getInfraCodeIndexDir(projectRoot), INFRA_CODE_INDEX_FILE);
}

export async function buildInfraCodeIndex(projectRoot: string): Promise<InfraCodeIndex> {
  const entries = await fg(SOURCE_PATTERNS, {
    cwd: projectRoot,
    onlyFiles: true,
    dot: false,
    unique: true,
    ignore: IGNORE_PATTERNS,
  });

  const files: CodeFile[] = [];
  const symbols: CodeSymbol[] = [];
  const contentsByPath = new Map<string, string>();
  let skippedLargeFiles = 0;

  for (const entry of entries.sort()) {
    const relativePath = toPosix(entry);
    const absolutePath = path.join(projectRoot, relativePath);
    const stat = await fs.stat(absolutePath);
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      skippedLargeFiles++;
      continue;
    }

    const content = await fs.readFile(absolutePath, 'utf-8');
    const language = detectLanguage(relativePath);
    const imports = extractImports(content, language);
    const lineCount = content.split('\n').length;
    const fileSymbols = extractSymbols(relativePath, language, content);
    const fileTerms = uniqueTerms([
      ...termsFromPath(relativePath),
      ...imports.flatMap((item) => termsFromPath(item)),
      ...fileSymbols.flatMap((symbol) => symbol.terms),
    ]);

    files.push({
      id: fileId(relativePath),
      path: relativePath,
      language,
      hash: hashContent(content),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      lineCount,
      terms: fileTerms,
      imports,
    });
    symbols.push(...fileSymbols);
    contentsByPath.set(relativePath, content);
  }

  const edges = buildEdges(files, symbols, contentsByPath);

  return {
    version: INFRA_CODE_INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    projectRoot,
    files,
    symbols,
    edges,
    stats: {
      fileCount: files.length,
      symbolCount: symbols.length,
      edgeCount: edges.length,
      skippedLargeFiles,
    },
  };
}

export async function writeInfraCodeIndex(projectRoot: string, index: InfraCodeIndex): Promise<string> {
  const indexDir = getInfraCodeIndexDir(projectRoot);
  const indexPath = getInfraCodeIndexPath(projectRoot);
  await fs.mkdir(indexDir, { recursive: true });
  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
  return indexPath;
}
