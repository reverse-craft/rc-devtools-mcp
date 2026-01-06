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
 * Requirements: 2.4, 4.1, 4.2, 4.3, 4.4, 4.5, 6.5
 */

import type {ConstantEntry} from './vmasm-visitor.js';

/**
 * Regular expression to match K[n] references in expressions.
 * Matches patterns like K[0], K[123], K[42], etc.
 */
const K_REF_PATTERN = /K\[(\d+)\]/g;

/**
 * Regular expression to match nested K[K[n]] references.
 * Matches patterns like K[K[0]], K[K[123]], etc.
 */
const NESTED_K_REF_PATTERN = /K\[K\[(\d+)\]\]/g;

/**
 * Maximum recursion depth for nested constant resolution.
 * Prevents infinite loops in case of circular references.
 */
const MAX_RESOLUTION_DEPTH = 10;

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
 * constant pool. Handles nested references (K[K[n]]) and invalid indices gracefully.
 *
 * @param expression - The expression containing K[n] references
 * @param constants - Array of constant entries from the vmasm AST
 * @param options - Optional configuration for resolution
 * @returns ResolveResult with the resolved expression and metadata
 *
 * Requirements: 2.4, 4.1, 4.2, 4.3, 4.4, 4.5, 6.5
 *
 * @example
 * ```typescript
 * const constants = [
 *   { index: 0, type: 'String', value: 'hello' },
 *   { index: 1, type: 'Number', value: 42 },
 *   { index: 2, type: 'Number', value: 0 }  // K[2] = 0, so K[K[2]] = K[0] = "hello"
 * ];
 * const result = resolveConstantReferences('K[0] + K[1]', constants);
 * // result.resolved === '"hello" + 42'
 *
 * const nestedResult = resolveConstantReferences('K[K[2]]', constants);
 * // nestedResult.resolved === '"hello"'
 * ```
 */
export function resolveConstantReferences(
  expression: string,
  constants: ConstantEntry[],
  options?: {showErrorIndicator?: boolean}
): ResolveResult {
  const resolvedIndices: number[] = [];
  const invalidIndices: number[] = [];
  let hasReferences = false;
  const showErrorIndicator = options?.showErrorIndicator ?? false;

  // Build a map for O(1) lookup
  const constantMap = new Map<number, ConstantEntry>();
  for (const constant of constants) {
    constantMap.set(constant.index, constant);
  }

  // First pass: resolve nested K[K[n]] references
  let resolved = resolveNestedReferences(
    expression,
    constantMap,
    resolvedIndices,
    invalidIndices,
    showErrorIndicator
  );

  // Check if we had any nested references
  if (resolved !== expression) {
    hasReferences = true;
  }

  // Second pass: resolve remaining simple K[n] references
  // Use a pattern that doesn't match K[n] that's already followed by error indicator
  const simpleKRefPattern = showErrorIndicator
    ? /K\[(\d+)\](?! <out of bounds>)/g
    : K_REF_PATTERN;

  resolved = resolved.replace(simpleKRefPattern, (match, indexStr) => {
    hasReferences = true;
    const index = parseInt(indexStr, 10);

    const constant = constantMap.get(index);
    if (!constant) {
      if (!invalidIndices.includes(index)) {
        invalidIndices.push(index);
      }
      // Requirements 4.5: Display original K[n] with error indicator for out-of-bounds
      return showErrorIndicator ? `${match} <out of bounds>` : match;
    }

    if (!resolvedIndices.includes(index)) {
      resolvedIndices.push(index);
    }
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
 * Resolve nested K[K[n]] references recursively.
 *
 * Handles patterns like K[K[0]], K[K[K[0]]], etc. by resolving from
 * the innermost reference outward.
 *
 * Requirements: 4.2
 *
 * @param expression - Expression containing nested references
 * @param constantMap - Map of index to constant entry
 * @param resolvedIndices - Array to track resolved indices
 * @param invalidIndices - Array to track invalid indices
 * @param showErrorIndicator - Whether to show error indicator for invalid indices
 * @param depth - Current recursion depth (for safety)
 * @returns Expression with nested references resolved
 */
function resolveNestedReferences(
  expression: string,
  constantMap: Map<number, ConstantEntry>,
  resolvedIndices: number[],
  invalidIndices: number[],
  showErrorIndicator: boolean,
  depth: number = 0
): string {
  // Safety check to prevent infinite recursion
  if (depth >= MAX_RESOLUTION_DEPTH) {
    return expression;
  }

  // Check if there are any nested references (use non-global pattern for test)
  const hasNestedPattern = /K\[K\[(\d+)\]\]/.test(expression);
  if (!hasNestedPattern) {
    return expression;
  }

  // Create a fresh regex for replacement to avoid lastIndex issues
  const regex = /K\[K\[(\d+)\]\]/g;

  // Resolve one level of nesting at a time
  const resolved = expression.replace(regex, (match, innerIndexStr) => {
    const innerIndex = parseInt(innerIndexStr, 10);

    // Get the inner constant value
    const innerConstant = constantMap.get(innerIndex);
    if (!innerConstant) {
      if (!invalidIndices.includes(innerIndex)) {
        invalidIndices.push(innerIndex);
      }
      return showErrorIndicator ? `${match} <out of bounds>` : match;
    }

    if (!resolvedIndices.includes(innerIndex)) {
      resolvedIndices.push(innerIndex);
    }

    // The inner constant should be a number that serves as the outer index
    if (innerConstant.type !== 'Number' || typeof innerConstant.value !== 'number') {
      // If inner value is not a number, we can't use it as an index
      // Return the partially resolved form: K[<value>]
      return `K[${formatConstantValue(innerConstant)}]`;
    }

    const outerIndex = innerConstant.value as number;

    // Now resolve K[outerIndex]
    const outerConstant = constantMap.get(outerIndex);
    if (!outerConstant) {
      if (!invalidIndices.includes(outerIndex)) {
        invalidIndices.push(outerIndex);
      }
      return showErrorIndicator ? `K[${outerIndex}] <out of bounds>` : `K[${outerIndex}]`;
    }

    if (!resolvedIndices.includes(outerIndex)) {
      resolvedIndices.push(outerIndex);
    }

    return formatConstantValue(outerConstant);
  });

  // Recursively resolve any remaining nested references
  // Use non-global pattern for test to avoid lastIndex issues
  if (resolved !== expression && /K\[K\[(\d+)\]\]/.test(resolved)) {
    return resolveNestedReferences(
      resolved,
      constantMap,
      resolvedIndices,
      invalidIndices,
      showErrorIndicator,
      depth + 1
    );
  }

  return resolved;
}

/**
 * Format a constant value for display in an expression.
 *
 * Requirements: 4.3, 4.4
 *
 * @param constant - The constant entry to format
 * @returns Formatted string representation
 */
function formatConstantValue(constant: ConstantEntry): string {
  switch (constant.type) {
    case 'String':
      // Requirements 4.3: String constants with quotes
      return JSON.stringify(constant.value);

    case 'Number':
      return String(constant.value);

    case 'Boolean':
      return String(constant.value);

    case 'Null':
      return 'null';

    case 'Object':
      // Requirements 4.4: Object/array preview
      return formatObjectPreview(constant.value);

    default:
      return String(constant.value);
  }
}

/**
 * Format an object or array value for preview display.
 *
 * Requirements: 4.4
 *
 * @param value - The object/array value (may be string or actual object)
 * @param maxLength - Maximum length for the preview (default: 50)
 * @returns Formatted preview string
 */
function formatObjectPreview(value: unknown, maxLength: number = 50): string {
  // Object values are often stored as strings in the constant pool
  if (typeof value === 'string') {
    // Try to parse as JSON to determine if it's an array or object
    try {
      const parsed = JSON.parse(value);
      return formatParsedObjectPreview(parsed, maxLength);
    } catch {
      // Not valid JSON, return as-is with truncation
      if (value.length > maxLength) {
        return value.substring(0, maxLength - 3) + '...';
      }
      return value;
    }
  }

  // Handle actual objects/arrays
  return formatParsedObjectPreview(value, maxLength);
}

/**
 * Format a parsed object or array for preview.
 *
 * @param value - The parsed object/array
 * @param maxLength - Maximum length for the preview
 * @returns Formatted preview string
 */
function formatParsedObjectPreview(value: unknown, maxLength: number): string {
  if (Array.isArray(value)) {
    // Array preview: [item1, item2, ...]
    const preview = JSON.stringify(value);
    if (preview.length > maxLength) {
      // Show truncated array with element count
      const count = value.length;
      const truncated = preview.substring(0, maxLength - 10);
      return `${truncated}... (${count} items)`;
    }
    return preview;
  }

  if (value !== null && typeof value === 'object') {
    // Object preview: {key1: val1, ...}
    const preview = JSON.stringify(value);
    if (preview.length > maxLength) {
      // Show truncated object with key count
      const keys = Object.keys(value);
      const truncated = preview.substring(0, maxLength - 10);
      return `${truncated}... (${keys.length} keys)`;
    }
    return preview;
  }

  // Fallback for other types
  return String(value);
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
 * @param showErrorIndicator - Whether to show error indicator for invalid indices
 * @returns The resolved value string or the original reference if not found
 *
 * Requirements: 4.5
 */
export function resolveSingleReference(
  kRef: string,
  constants: ConstantEntry[],
  showErrorIndicator: boolean = false
): string {
  const match = kRef.match(/^K\[(\d+)\]$/);
  if (!match) {
    return kRef;
  }

  const index = parseInt(match[1], 10);
  const constant = constants.find(c => c.index === index);

  if (!constant) {
    // Requirements 4.5: Display original K[n] with error indicator for out-of-bounds
    return showErrorIndicator ? `${kRef} <out of bounds>` : kRef;
  }

  return formatConstantValue(constant);
}

/**
 * Resolve constant references with error indicators for invalid indices.
 *
 * This is a convenience wrapper around resolveConstantReferences that
 * enables error indicators by default.
 *
 * Requirements: 4.5
 *
 * @param expression - The expression containing K[n] references
 * @param constants - Array of constant entries from the vmasm AST
 * @returns ResolveResult with the resolved expression and metadata
 */
export function resolveConstantReferencesWithErrors(
  expression: string,
  constants: ConstantEntry[]
): ResolveResult {
  return resolveConstantReferences(expression, constants, {showErrorIndicator: true});
}
