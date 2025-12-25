/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as acorn from 'acorn';

/**
 * Type definitions for JavaScript call graph analysis components.
 */

/**
 * Type of function definition recognized by the parser.
 */
export type FunctionType =
  | 'declaration' // function foo() {}
  | 'expression' // const foo = function() {}
  | 'arrow' // const foo = () => {}
  | 'method' // { foo() {} } or class { foo() {} }
  | 'anonymous'; // Anonymous functions with contextual identifiers

/**
 * Information about a function definition found in a script.
 */
export interface FunctionInfo {
  /** Function name (anonymous functions use contextual identifiers) */
  name: string;
  /** Script ID from CDP */
  scriptId: string;
  /** Script URL */
  scriptUrl: string;
  /** Line number (1-based) */
  lineNumber: number;
  /** Column number (0-based) */
  columnNumber: number;
  /** Parameter names */
  params: string[];
  /** Type of function definition */
  type: FunctionType;
}

/**
 * Information about a function call relationship.
 */
export interface CallInfo {
  /** Name of the calling function */
  caller: string;
  /** Name of the called function */
  callee: string;
  /** Script ID where the call occurs */
  scriptId: string;
  /** Line number of the call (1-based) */
  lineNumber: number;
  /** Column number of the call (0-based) */
  columnNumber: number;
}


/**
 * Error information from parsing a script.
 */
export interface ParseError {
  /** Script ID */
  scriptId: string;
  /** Script URL */
  scriptUrl: string;
  /** Error message */
  message: string;
  /** Line number where error occurred (optional) */
  line?: number;
  /** Column number where error occurred (optional) */
  column?: number;
}

/**
 * Result of parsing a single script.
 * Enhanced to include the complete AST for local formatting.
 */
export interface ParseResult {
  /** The complete AST root node (Program) */
  ast: acorn.Node | null;
  /** Functions defined in the script */
  functions: FunctionInfo[];
  /** Function calls found in the script */
  calls: CallInfo[];
  /** Errors encountered during parsing */
  errors: ParseError[];
  /** Line offset array for efficient position conversion */
  lineOffsets?: number[];
}

/**
 * Call graph structure representing function call relationships.
 */
export interface CallGraph {
  /** Adjacency list: caller -> Set of callees */
  calls: Map<string, Set<string>>;
  /** Reverse adjacency list: callee -> Set of callers */
  calledBy: Map<string, Set<string>>;
  /** Function information indexed by name */
  functions: Map<string, FunctionInfo>;
}

/**
 * Recursive trace result structure for displaying call hierarchies.
 */
export interface TraceResult {
  [functionName: string]: TraceResult | 'Leaf';
}

/**
 * Result of analyzing a function's call graph.
 */
export interface CallGraphResult {
  /** The function being analyzed */
  targetFunction: string;
  /** Whether the function was found in the call graph */
  found: boolean;
  /** Upstream trace (functions that call this function) */
  upstream: TraceResult;
  /** Downstream trace (functions called by this function) */
  downstream: TraceResult;
  /** Information about the target function (if found) */
  functionInfo?: FunctionInfo;
  /** Similar function names (when target not found) */
  similarFunctions?: string[];
}

/**
 * A single match found during script content search.
 */
export interface SearchMatch {
  /** Script ID from CDP */
  scriptId: string;
  /** Script URL */
  scriptUrl: string;
  /** Line number (1-based) */
  lineNumber: number;
  /** Column number (0-based) */
  columnNumber: number;
  /** The matched text */
  matchText: string;
  /** Context around the match */
  context: string;
}

/**
 * Result of searching script content.
 */
export interface SearchResult {
  /** The search pattern used */
  pattern: string;
  /** Whether the pattern was treated as regex */
  isRegex: boolean;
  /** Total number of matches found */
  totalMatches: number;
  /** Array of matches */
  matches: SearchMatch[];
}
