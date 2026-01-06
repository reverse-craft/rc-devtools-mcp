/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AST Transform Utilities - AST-based identifier substitution using Babel
 *
 * Provides functionality to parse JavaScript expressions and substitute
 * register identifiers (stack, sp, ip, bc, storage, const, scope) with
 * actual variable names using Babel's AST traversal.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7
 */

import * as parser from '@babel/parser';
import _traverse, {type NodePath} from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';

// Handle ESM/CJS interop for Babel packages
const traverse = (
  typeof _traverse === 'function' ? _traverse : (_traverse as {default: typeof _traverse}).default
) as typeof _traverse;
const generate = (
  typeof _generate === 'function' ? _generate : (_generate as {default: typeof _generate}).default
) as typeof _generate;

import {logger} from './logger.js';

/**
 * Represents a single identifier substitution made during transformation
 */
export interface Substitution {
  /** Original identifier name (e.g., "stack") */
  original: string;
  /** Replacement identifier name (e.g., "v") */
  replacement: string;
  /** Character position in original expression */
  position: number;
}

/**
 * Result of transforming an expression
 */
export interface TransformResult {
  /** Original expression */
  original: string;
  /** Transformed expression with substituted identifiers */
  transformed: string;
  /** Whether any substitution was made */
  wasTransformed: boolean;
  /** List of substitutions made */
  substitutions: Substitution[];
  /** Error message if transformation failed */
  error?: string;
}

/**
 * Register mapping from generic names to actual variable names
 */
export interface RegisterMapping {
  /** Instruction pointer variable */
  ip?: string;
  /** Stack pointer variable */
  sp?: string;
  /** Stack array variable */
  stack?: string;
  /** Bytecode array variable */
  bc?: string;
  /** Storage object variable */
  storage?: string;
  /** Constants array variable */
  const?: string;
  /** Scope chain variable */
  scope?: string;
}

/**
 * Known register identifiers that may appear in transform expressions.
 * Used for logging warnings when mappings are missing.
 * Requirement 5.2: Track which register identifiers are expected
 */
const KNOWN_REGISTER_IDENTIFIERS = ['stack', 'sp', 'ip', 'bc', 'storage', 'const', 'scope'];

/**
 * IdentifierSubstitutor - Core class for AST-based identifier replacement
 *
 * Uses Babel's parser and traverse to safely replace register identifiers
 * with actual variable names while preserving expression structure.
 *
 * Requirements:
 * - 2.2: Replace Identifier nodes matching register names
 * - 2.3: Preserve original expression structure
 * - 2.4: Skip property names in MemberExpression (non-computed)
 * - 2.5: Skip identifiers inside string literals (handled by AST - strings are StringLiteral nodes)
 * - 2.6: Handle complex expressions with nested calls, array access, arithmetic
 * - 2.7: Fall back to original expression on parse failure
 * - 5.2: Keep original identifier unchanged when register mapping is missing
 * - 5.3: Log warnings for failed transformations without interrupting output
 */
export class IdentifierSubstitutor {
  /**
   * Substitute register identifiers in an expression with actual variable names
   *
   * @param expression - Original JavaScript expression
   * @param mapping - Map of register names to actual variable names
   * @returns TransformResult with transformed expression and substitution details
   *
   * Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 5.2, 5.3
   */
  substituteIdentifiers(
    expression: string,
    mapping: RegisterMapping
  ): TransformResult {
    const result: TransformResult = {
      original: expression,
      transformed: expression,
      wasTransformed: false,
      substitutions: [],
    };

    // Skip empty expressions
    if (!expression || expression.trim() === '') {
      return result;
    }

    // Build mapping entries for lookup, filtering out undefined/empty values
    // Requirement 5.2: Missing mappings are handled gracefully
    const mappingEntries = Object.entries(mapping).filter(
      ([, value]) => value !== undefined && value !== ''
    );

    // Log warning if no mappings are available but expression contains register identifiers
    // Requirement 5.3: Log warnings without interrupting output
    if (mappingEntries.length === 0) {
      const hasRegisterIdentifiers = KNOWN_REGISTER_IDENTIFIERS.some(
        id => expression.includes(id)
      );
      if (hasRegisterIdentifiers) {
        logger(`AST transform: No register mappings available for expression "${expression}". Identifiers will remain unchanged.`);
      }
      return result;
    }

    // Check for missing mappings that might be needed
    // Requirement 5.2, 5.3: Log warnings for missing mappings
    const missingMappings: string[] = [];
    for (const registerId of KNOWN_REGISTER_IDENTIFIERS) {
      if (expression.includes(registerId)) {
        const hasMapping = mappingEntries.some(([key]) => key === registerId);
        if (!hasMapping) {
          missingMappings.push(registerId);
        }
      }
    }
    if (missingMappings.length > 0) {
      logger(`AST transform: Missing register mappings for [${missingMappings.join(', ')}] in expression "${expression}". These identifiers will remain unchanged.`);
    }

    try {
      // Parse expression as a JavaScript expression
      const ast = parser.parse(expression, {
        sourceType: 'module',
        plugins: ['jsx'],
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true,
      });

      const substitutions: Substitution[] = [];

      // Traverse AST and replace matching Identifier nodes
      traverse(ast, {
        Identifier(path: NodePath<t.Identifier>) {
          const name = path.node.name;

          // Skip if this is a property name in non-computed MemberExpression (obj.property)
          // Requirement 2.4: Do not replace identifiers that are part of property names
          if (
            t.isMemberExpression(path.parent) &&
            path.parent.property === path.node &&
            !path.parent.computed
          ) {
            return;
          }

          // Skip if this is a key in object literal (ObjectProperty)
          if (
            t.isObjectProperty(path.parent) &&
            path.parent.key === path.node &&
            !path.parent.computed
          ) {
            return;
          }

          // Skip if this is a function name in FunctionDeclaration/FunctionExpression
          if (
            (t.isFunctionDeclaration(path.parent) ||
              t.isFunctionExpression(path.parent)) &&
            path.parent.id === path.node
          ) {
            return;
          }

          // Skip if this is a parameter name
          if (
            (t.isFunctionDeclaration(path.parent) ||
              t.isFunctionExpression(path.parent) ||
              t.isArrowFunctionExpression(path.parent)) &&
            path.parent.params.includes(path.node as t.Identifier)
          ) {
            return;
          }

          // Check if identifier matches a register name
          for (const [registerName, actualName] of mappingEntries) {
            if (name === registerName && actualName) {
              substitutions.push({
                original: name,
                replacement: actualName,
                position: path.node.start || 0,
              });
              path.node.name = actualName;
              break;
            }
          }
        },
      });

      // Generate code from modified AST
      const output = generate(ast, {
        compact: false,
        retainLines: false,
        comments: false,
      });

      // Clean up generated code (remove trailing semicolon, extra whitespace)
      let transformed = output.code.trim();
      if (transformed.endsWith(';')) {
        transformed = transformed.slice(0, -1);
      }

      result.transformed = transformed;
      result.wasTransformed = substitutions.length > 0;
      result.substitutions = substitutions;

      return result;
    } catch (error) {
      // Requirement 2.7: Fall back to original expression on parse failure
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger(`AST transform failed for expression "${expression}": ${errorMessage}`);

      result.error = errorMessage;
      return result;
    }
  }
}

/**
 * Convenience function to substitute identifiers in an expression
 *
 * @param expression - Original JavaScript expression
 * @param mapping - Map of register names to actual variable names
 * @returns TransformResult with transformed expression and substitution details
 */
export function substituteIdentifiers(
  expression: string,
  mapping: RegisterMapping
): TransformResult {
  const substitutor = new IdentifierSubstitutor();
  return substitutor.substituteIdentifiers(expression, mapping);
}
