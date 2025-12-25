/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * CallGraphAnalyzer module for building and querying function call graphs.
 */

import type {
  CallGraph,
  CallGraphResult,
  FunctionInfo,
  ParseResult,
  TraceResult,
} from './analysis-types.js';

/**
 * Build a call graph from multiple parse results.
 * Creates both forward (calls) and reverse (calledBy) adjacency lists.
 *
 * @param parseResults - Array of ParseResult from parsing scripts
 * @returns CallGraph with calls, calledBy, and functions maps
 */
export function buildCallGraph(parseResults: ParseResult[]): CallGraph {
  const calls = new Map<string, Set<string>>();
  const calledBy = new Map<string, Set<string>>();
  const functions = new Map<string, FunctionInfo>();

  for (const result of parseResults) {
    // Index all functions
    for (const func of result.functions) {
      // If multiple functions have the same name, keep the first one
      if (!functions.has(func.name)) {
        functions.set(func.name, func);
      }
    }

    // Build call relationships
    for (const call of result.calls) {
      // Add to calls map (caller -> callees)
      if (!calls.has(call.caller)) {
        calls.set(call.caller, new Set());
      }
      calls.get(call.caller)!.add(call.callee);

      // Add to calledBy map (callee -> callers)
      if (!calledBy.has(call.callee)) {
        calledBy.set(call.callee, new Set());
      }
      calledBy.get(call.callee)!.add(call.caller);
    }
  }

  return {calls, calledBy, functions};
}


/**
 * Get upstream trace (callers) for a function up to specified depth.
 * Uses DFS to build a tree of callers.
 *
 * @param graph - The call graph
 * @param functionName - Target function name
 * @param depth - Maximum depth to trace (0 = no callers, 1 = direct callers, etc.)
 * @returns TraceResult tree of upstream callers
 */
export function getUpstreamTrace(
  graph: CallGraph,
  functionName: string,
  depth: number
): TraceResult {
  const result: TraceResult = {};
  const visited = new Set<string>();

  function trace(name: string, currentDepth: number): TraceResult {
    if (currentDepth <= 0 || visited.has(name)) {
      return {};
    }

    visited.add(name);
    const callers = graph.calledBy.get(name);

    if (!callers || callers.size === 0) {
      visited.delete(name);
      return {};
    }

    const traceResult: TraceResult = {};
    for (const caller of callers) {
      if (visited.has(caller)) {
        // Mark cycles
        traceResult[caller] = 'Leaf';
      } else {
        const subTrace = trace(caller, currentDepth - 1);
        traceResult[caller] = Object.keys(subTrace).length > 0 ? subTrace : 'Leaf';
      }
    }

    visited.delete(name);
    return traceResult;
  }

  const callers = graph.calledBy.get(functionName);
  if (callers) {
    for (const caller of callers) {
      const subTrace = trace(caller, depth - 1);
      result[caller] = Object.keys(subTrace).length > 0 ? subTrace : 'Leaf';
    }
  }

  return result;
}


/**
 * Get downstream trace (callees) for a function up to specified depth.
 * Uses DFS to build a tree of callees.
 *
 * @param graph - The call graph
 * @param functionName - Target function name
 * @param depth - Maximum depth to trace (0 = no callees, 1 = direct callees, etc.)
 * @returns TraceResult tree of downstream callees
 */
export function getDownstreamTrace(
  graph: CallGraph,
  functionName: string,
  depth: number
): TraceResult {
  const result: TraceResult = {};
  const visited = new Set<string>();

  function trace(name: string, currentDepth: number): TraceResult {
    if (currentDepth <= 0 || visited.has(name)) {
      return {};
    }

    visited.add(name);
    const callees = graph.calls.get(name);

    if (!callees || callees.size === 0) {
      visited.delete(name);
      return {};
    }

    const traceResult: TraceResult = {};
    for (const callee of callees) {
      if (visited.has(callee)) {
        // Mark cycles
        traceResult[callee] = 'Leaf';
      } else {
        const subTrace = trace(callee, currentDepth - 1);
        traceResult[callee] = Object.keys(subTrace).length > 0 ? subTrace : 'Leaf';
      }
    }

    visited.delete(name);
    return traceResult;
  }

  const callees = graph.calls.get(functionName);
  if (callees) {
    for (const callee of callees) {
      const subTrace = trace(callee, depth - 1);
      result[callee] = Object.keys(subTrace).length > 0 ? subTrace : 'Leaf';
    }
  }

  return result;
}


/**
 * Calculate Levenshtein distance between two strings.
 * Used for fuzzy matching function names.
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  // Initialize matrix
  for (let i = 0; i <= a.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) {
    matrix[0][j] = j;
  }

  // Fill matrix
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1, // deletion
        matrix[i][j - 1] + 1, // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }

  return matrix[a.length][b.length];
}

/**
 * Calculate similarity score between two strings (0 to 1).
 * Higher score means more similar.
 */
function stringSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const distance = levenshteinDistance(a.toLowerCase(), b.toLowerCase());
  return 1 - distance / maxLen;
}

/**
 * Find functions with names similar to the target.
 * Uses string similarity based on Levenshtein distance.
 *
 * @param graph - The call graph
 * @param functionName - Target function name to match
 * @param limit - Maximum number of similar functions to return
 * @returns Array of similar function names, sorted by similarity
 */
export function findSimilarFunctions(
  graph: CallGraph,
  functionName: string,
  limit = 5
): string[] {
  const similarities: Array<{name: string; score: number}> = [];

  for (const name of graph.functions.keys()) {
    // Skip exact match
    if (name === functionName) continue;

    const score = stringSimilarity(functionName, name);
    // Also boost score if target is a substring
    const substringBoost = name.toLowerCase().includes(functionName.toLowerCase()) ? 0.3 : 0;
    similarities.push({name, score: score + substringBoost});
  }

  // Sort by similarity (descending) and return top N
  return similarities
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.name);
}


/**
 * Analyze a function's call graph, including upstream and downstream traces.
 * Main entry point for call graph analysis.
 *
 * @param graph - The call graph
 * @param functionName - Target function name to analyze
 * @param upstreamDepth - Maximum depth for upstream trace (default: 3)
 * @param downstreamDepth - Maximum depth for downstream trace (default: 3)
 * @returns CallGraphResult with traces and function info
 */
export function analyzeFunction(
  graph: CallGraph,
  functionName: string,
  upstreamDepth = 3,
  downstreamDepth = 3
): CallGraphResult {
  const functionInfo = graph.functions.get(functionName);
  const found = functionInfo !== undefined;

  if (!found) {
    // Function not found, return similar functions
    const similarFunctions = findSimilarFunctions(graph, functionName);
    return {
      targetFunction: functionName,
      found: false,
      upstream: {},
      downstream: {},
      similarFunctions,
    };
  }

  // Get upstream and downstream traces
  const upstream = getUpstreamTrace(graph, functionName, upstreamDepth);
  const downstream = getDownstreamTrace(graph, functionName, downstreamDepth);

  return {
    targetFunction: functionName,
    found: true,
    upstream,
    downstream,
    functionInfo,
  };
}
