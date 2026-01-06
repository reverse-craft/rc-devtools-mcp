/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Constant Resolver - Resolves K[n] references in expressions
 *
 * Provides functionality to resolve constant references (K[n]) in
 * transform expressions to their actual values from the constant pool.
 *
 * Requirements: 2.4, 6.5
 */

import type {ConstantEntry} from './vmasm-visitor.js';

/**
 * Regular expression to match K[n] references in expressions.
 * Matches patterns like K[0], K[123], K[42], etc.
 */
const K_REF_PATTERN = /K\[(\d+)\]/g;

/**
 * Result of resolving constant references in an expression.
 */
export interface ResolveResult {
  /** The expression with K[n] references replaced by values */
  resolved: string;
  /** Whether any references were resolved */
  hasReferences: boolean;
  /** List of indices that were resolved */
  resolvedIndices: number[];
  /** List of indices that were invalid (out of bounds) */
  invalidIndices: number[];
}

/**
 * Resolve K[n] constant references in an expression.
 *
 * Replaces K[n] patterns with the actual constant values from the
 * constant pool. Handles nested references and invalid indices gracefully.
 *
 * @param expression - The expression containing K[n] references
 * @param constants - Array of constant entries from the vmasm AST
 * @returns ResolveResult with the resolved expression and metadata
 *
 * Requirements: 2.4, 6.5
 *
 * @example
 * ```typescript
 * const constants = [
 *   { index: 0, type: 'String', value: 'hello' },
 *   { index: 1, type: 'Number', value: 42 }
 * ];
 * const result = resolveConstantReferences('K[0] + K[1]', constants);
 * // result.resolved === '"hello" + 42'
 * ```
 */
export function resolveConstantReferences(
  expression: string,
  constants: ConstantEntry[]
): ResolveResult {
  const resolvedIndices: number[] = [];
  const invalidIndices: number[] = [];
  let hasReferences = false;

  // Build a map for O(1) lookup
  const constantMap = new Map<number, ConstantEntry>();
  for (const constant of constants) {
    constantMap.set(constant.index, constant);
  }

  // Replace all K[n] references
  const resolved = expression.replace(K_REF_PATTERN, (match, indexStr) => {
    hasReferences = true;
    const index = parseInt(indexStr, 10);

    const constant = constantMap.get(index);
    if (!constant) {
      invalidIndices.push(index);
      return match; // Keep original if not found
    }

    resolvedIndices.push(index);
    return formatConstantValue(constant);
  });

  return {
    resolved,
    hasReferences,
    resolvedIndices,
    invalidIndices,
  };
}

/**
 * Format a constant value for display in an expression.
 *
 * @param constant - The constant entry to format
 * @returns Formatted string representation
 */
function formatConstantValue(constant: ConstantEntry): string {
  switch (constant.type) {
    case 'String':
      // Escape and quote strings
      return JSON.stringify(constant.value);

    case 'Number':
      return String(constant.value);

    case 'Boolean':
      return String(constant.value);

    case 'Null':
      return 'null';

    case 'Object':
      // Object values are stored as strings in the constant pool
      if (typeof constant.value === 'string') {
        return constant.value;
      }
      return JSON.stringify(constant.value);

    default:
      return String(constant.value);
  }
}

/**
 * Check if an expression contains K[n] references.
 *
 * @param expression - The expression to check
 * @returns true if the expression contains K[n] references
 */
export function hasConstantReferences(expression: string): boolean {
  // Use a new regex instance to avoid lastIndex state issues
  const pattern = /K\[(\d+)\]/;
  return pattern.test(expression);
}

/**
 * Extract all K[n] indices from an expression.
 *
 * @param expression - The expression to extract from
 * @returns Array of indices found in the expression
 */
export function extractConstantIndices(expression: string): number[] {
  const indices: number[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  const regex = new RegExp(K_REF_PATTERN.source, 'g');

  while ((match = regex.exec(expression)) !== null) {
    indices.push(parseInt(match[1], 10));
  }

  return indices;
}

/**
 * Get the constant value at a specific index.
 *
 * @param index - The constant index
 * @param constants - Array of constant entries
 * @returns The constant entry or undefined if not found
 */
export function getConstantAtIndex(
  index: number,
  constants: ConstantEntry[]
): ConstantEntry | undefined {
  return constants.find(c => c.index === index);
}

/**
 * Format a constant for inline display (shorter format).
 * Used when displaying constants inline in bytecode context.
 *
 * @param constant - The constant entry to format
 * @param maxLength - Maximum length before truncation (default: 30)
 * @returns Short formatted string
 *
 * Requirements: 6.5
 */
export function formatConstantInline(
  constant: ConstantEntry,
  maxLength: number = 30
): string {
  let formatted: string;

  switch (constant.type) {
    case 'String': {
      const str = constant.value as string;
      if (str.length > maxLength - 2) {
        formatted = JSON.stringify(str.substring(0, maxLength - 5) + '...');
      } else {
        formatted = JSON.stringify(str);
      }
      break;
    }

    case 'Number':
      formatted = String(constant.value);
      break;

    case 'Boolean':
      formatted = String(constant.value);
      break;

    case 'Null':
      formatted = 'null';
      break;

    case 'Object': {
      const objStr = typeof constant.value === 'string'
        ? constant.value
        : JSON.stringify(constant.value);
      if (objStr.length > maxLength) {
        formatted = objStr.substring(0, maxLength - 3) + '...';
      } else {
        formatted = objStr;
      }
      break;
    }

    default:
      formatted = String(constant.value);
  }

  return formatted;
}

/**
 * Resolve a single K[n] reference to its display value.
 *
 * @param kRef - The K[n] reference string (e.g., "K[0]")
 * @param constants - Array of constant entries
 * @returns The resolved value string or the original reference if not found
 */
export function resolveSingleReference(
  kRef: string,
  constants: ConstantEntry[]
): string {
  const match = kRef.match(/^K\[(\d+)\]$/);
  if (!match) {
    return kRef;
  }

  const index = parseInt(match[1], 10);
  const constant = constants.find(c => c.index === index);

  if (!constant) {
    return kRef;
  }

  return formatConstantValue(constant);
}
