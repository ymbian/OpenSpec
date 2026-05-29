export const INFRA_CODE_INDEX_VERSION = 1;

export type CodeLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'java'
  | 'unknown';

export type CodeSymbolKind =
  | 'function'
  | 'component'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'method'
  | 'variable';

export type CodeEdgeKind = 'imports' | 'calls' | 'references';

export type CodeEdgeConfidence = 'high' | 'medium' | 'low';

export interface CodeFile {
  id: string;
  path: string;
  language: CodeLanguage;
  hash: string;
  size: number;
  mtimeMs: number;
  lineCount: number;
  terms: string[];
  imports: string[];
}

export interface CodeSymbol {
  id: string;
  name: string;
  kind: CodeSymbolKind;
  filePath: string;
  language: CodeLanguage;
  startLine: number;
  endLine: number;
  signature?: string;
  exported?: boolean;
  terms: string[];
}

export interface CodeEdge {
  source: string;
  target: string;
  kind: CodeEdgeKind;
  confidence: CodeEdgeConfidence;
}

export interface InfraCodeIndex {
  version: typeof INFRA_CODE_INDEX_VERSION;
  generatedAt: string;
  projectRoot: string;
  files: CodeFile[];
  symbols: CodeSymbol[];
  edges: CodeEdge[];
  stats: {
    fileCount: number;
    symbolCount: number;
    edgeCount: number;
    skippedLargeFiles: number;
    parserBackend: 'tree-sitter-wasm' | 'regex' | 'mixed';
    treeSitterFiles: number;
    regexFallbackFiles: number;
    parseErrors: string[];
  };
}

export interface ScoredSymbol {
  symbol: CodeSymbol;
  score: number;
  matchedTerms: string[];
  reasons: string[];
}

export interface ScoredFile {
  file: CodeFile;
  score: number;
  matchedTerms: string[];
}

export interface CodeBlock {
  symbol: CodeSymbol;
  filePath: string;
  startLine: number;
  endLine: number;
  language: CodeLanguage;
  content: string;
}

export interface CodeContext {
  query: string;
  expandedTerms: string[];
  entrySymbols: ScoredSymbol[];
  relatedSymbols: ScoredSymbol[];
  relevantFiles: ScoredFile[];
  relatedEdges: CodeEdge[];
  codeBlocks: CodeBlock[];
  impact: {
    files: string[];
    symbols: string[];
  };
  gaps: string[];
  stats: {
    indexedFiles: number;
    indexedSymbols: number;
    indexedEdges: number;
    entrySymbolCount: number;
    relevantFileCount: number;
    codeBlockCount: number;
    parserBackend: 'tree-sitter-wasm' | 'regex' | 'mixed';
    treeSitterFiles: number;
    regexFallbackFiles: number;
  };
}
