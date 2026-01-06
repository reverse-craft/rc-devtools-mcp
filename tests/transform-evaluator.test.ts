/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Property-based tests for transform evaluator.
 *
 * Feature: vmasm-debug-enhancement
 * Property 4: Transform Expression Evaluation
 * Validates: Requirements 2.2, 2.4
 *
 * For any opcode transform with pre-expressions, all expressions SHALL be
 * evaluated and displayed with their resolved values. Constant references
 * (K[n]) SHALL be resolved to actual constant values.
 */

import {describe, it} from 'node:test';
import * as assert from 'node:assert';
import fc from 'fast-check';
import type {
  OpcodeTransform,
  TransformVariable,
  ConstantEntry,
} from '../src/utils/vmasm-visitor.js';
import {
  formatEvaluatedVariable,
  formatTransformSection,
  formatTransformOutput,
  summarizeVariables,
  TransformVariableProvider,
  type EvaluatedVariable,
  type TransformEvaluationResult,
} from '../src/utils/transform-evaluator.js';
import {resolveConstantReferences} from '../src/utils/constant-resolver.js';

// ==========================================
// Generators for property-based testing
// ==========================================

/**
 * Generate a valid variable name (alphanumeric starting with letter)
 */
const variableNameArb = fc.stringMatching(/^[a-z][a-zA-Z0-9_]{0,10}$/);

/**
 * Generate a constant entry
 */
const constantEntryArb = (index: number): fc.Arbitrary<ConstantEntry> =>
  fc.oneof(
    fc.string({minLength: 0, maxLength: 50}).map(value => ({
      index,
      type: 'String' as const,
      value,
    })),
    fc.integer({min: -1000000, max: 1000000}).map(value => ({
      index,
      type: 'Number' as const,
      value,
    })),
    fc.boolean().map(value => ({
      index,
      type: 'Boolean' as const,
      value,
    })),
    fc.constant({index, type: 'Null' as const, value: null})
  );

/**
 * Generate an array of constant entries with sequential indices
 */
const constantsArb = fc.integer({min: 0, max: 10}).chain(count =>
  fc.tuple(...Array.from({length: count}, (_, i) => constantEntryArb(i)))
);

/**
 * Generate a simple expression that may contain K[n] references
 */
const expressionArb = (maxConstantIndex: number): fc.Arbitrary<string> => {
  if (maxConstantIndex < 0) {
    // No constants available, generate simple expressions
    return fc.oneof(
      fc.constant('v[p]'),
      fc.constant('v[p - 1]'),
      fc.constant('a + b'),
      variableNameArb
    );
  }

  return fc.oneof(
    // Simple variable reference
    variableNameArb,
    // Stack reference
    fc.constant('v[p]'),
    fc.constant('v[p - 1]'),
    // Constant reference
    fc.integer({min: 0, max: maxConstantIndex}).map(i => `K[${i}]`),
    // Expression with constant
    fc.integer({min: 0, max: maxConstantIndex}).map(i => `v[p] === K[${i}]`),
    // Binary expression with constants
    fc
      .tuple(
        fc.integer({min: 0, max: maxConstantIndex}),
        fc.integer({min: 0, max: maxConstantIndex})
      )
      .map(([i, j]) => `K[${i}] + K[${j}]`)
  );
};

/**
 * Generate a transform variable
 */
const transformVariableArb = (
  maxConstantIndex: number
): fc.Arbitrary<TransformVariable> =>
  fc.record({
    name: variableNameArb,
    expression: expressionArb(maxConstantIndex),
    isPost: fc.boolean(),
  });

/**
 * Generate an opcode transform
 */
const opcodeTransformArb = (
  maxConstantIndex: number
): fc.Arbitrary<OpcodeTransform> =>
  fc.record({
    opcodeNumber: fc.integer({min: 0, max: 255}),
    opcodeName: fc.stringMatching(/^[A-Z][A-Z_]{0,10}$/),
    variables: fc.array(transformVariableArb(maxConstantIndex), {
      minLength: 0,
      maxLength: 5,
    }),
    postVariables: fc.array(transformVariableArb(maxConstantIndex), {
      minLength: 0,
      maxLength: 3,
    }),
    sourceLine: fc.option(fc.integer({min: 1, max: 1000}), {nil: undefined}),
  });

/**
 * Generate an evaluated variable (simulating evaluation result)
 */
const evaluatedVariableArb: fc.Arbitrary<EvaluatedVariable> = fc.record({
  name: variableNameArb,
  expression: fc.string({minLength: 1, maxLength: 50}),
  resolvedExpression: fc.string({minLength: 1, maxLength: 50}),
  transformedExpression: fc.string({minLength: 1, maxLength: 50}),
  value: fc.oneof(
    fc.string({minLength: 0, maxLength: 100}),
    fc.integer().map(String),
    fc.constant('true'),
    fc.constant('false'),
    fc.constant('null'),
    fc.constant('undefined'),
    fc.constant('Array(5) [1, 2, ...]'),
    fc.constant('Object {a: 1, ...}'),
    fc.constant('<error>')
  ),
  type: fc.oneof(
    fc.constant('string'),
    fc.constant('number'),
    fc.constant('boolean'),
    fc.constant('null'),
    fc.constant('undefined'),
    fc.constant('array'),
    fc.constant('object'),
    fc.constant('error')
  ),
  expandable: fc.boolean(),
  error: fc.option(fc.string({minLength: 1, maxLength: 50}), {nil: undefined}),
  isPost: fc.option(fc.boolean(), {nil: undefined}),
  wasTransformed: fc.boolean(),
});

// ==========================================
// Property Tests
// ==========================================

describe('Transform Evaluator Property Tests', () => {
  /**
   * Property 4: Transform Expression Evaluation
   * For any opcode transform with pre-expressions, all expressions SHALL be
   * evaluated and displayed with their resolved values. Constant references
   * (K[n]) SHALL be resolved to actual constant values.
   *
   * Validates: Requirements 2.2, 2.4
   */
  describe('Property 4: Transform Expression Evaluation', () => {
    it('K[n] references in expressions are resolved to constant values', () => {
      fc.assert(
        fc.property(constantsArb, constants => {
          // For each constant, create an expression referencing it
          for (const constant of constants) {
            const expression = `K[${constant.index}]`;
            const result = resolveConstantReferences(expression, constants);

            // The resolved expression should NOT contain K[n] for valid indices
            assert.strictEqual(
              result.hasReferences,
              true,
              'Expression should have references'
            );
            assert.ok(
              !result.resolved.includes(`K[${constant.index}]`),
              `K[${constant.index}] should be resolved in: ${result.resolved}`
            );
            assert.deepStrictEqual(
              result.invalidIndices,
              [],
              'No invalid indices for valid constants'
            );
          }
        }),
        {numRuns: 100}
      );
    });

    it('expressions with multiple K[n] references are all resolved', () => {
      fc.assert(
        fc.property(
          constantsArb.filter(c => c.length >= 2),
          constants => {
            // Create expression with multiple constant references
            const indices = constants.slice(0, 3).map(c => c.index);
            const expression = indices.map(i => `K[${i}]`).join(' + ');
            const result = resolveConstantReferences(expression, constants);

            // All valid K[n] references should be resolved
            for (const index of indices) {
              assert.ok(
                !result.resolved.includes(`K[${index}]`),
                `K[${index}] should be resolved`
              );
            }
            assert.deepStrictEqual(result.resolvedIndices.sort(), indices.sort());
          }
        ),
        {numRuns: 100}
      );
    });

    it('invalid K[n] indices are preserved in the expression', () => {
      fc.assert(
        fc.property(
          constantsArb,
          fc.integer({min: 100, max: 999}),
          (constants, invalidIndex) => {
            const expression = `K[${invalidIndex}]`;
            const result = resolveConstantReferences(expression, constants);

            // Invalid index should be preserved
            assert.strictEqual(
              result.resolved,
              expression,
              'Invalid K[n] should be preserved'
            );
            assert.deepStrictEqual(result.invalidIndices, [invalidIndex]);
          }
        ),
        {numRuns: 100}
      );
    });

    it('formatted variables contain name, value, and type info', () => {
      fc.assert(
        fc.property(evaluatedVariableArb, variable => {
          const formatted = formatEvaluatedVariable(variable);

          // Should contain the variable name
          assert.ok(
            formatted.includes(variable.name),
            `Formatted output should contain variable name: ${variable.name}`
          );

          // Should contain the value
          assert.ok(
            formatted.includes(variable.value),
            `Formatted output should contain value: ${variable.value}`
          );

          // Should contain expandable indicator if expandable
          if (variable.expandable) {
            assert.ok(
              formatted.includes('[+]'),
              'Expandable variables should have [+] indicator'
            );
          }

          // Should contain error if present
          if (variable.error) {
            assert.ok(
              formatted.includes('Error:'),
              'Error variables should show error message'
            );
          }
        }),
        {numRuns: 100}
      );
    });

    it('transform section formatting includes all variables', () => {
      fc.assert(
        fc.property(
          fc.array(evaluatedVariableArb, {minLength: 1, maxLength: 5}),
          variables => {
            const result: TransformEvaluationResult = {
              hasTransforms: true,
              current: {
                opcodeNumber: 42,
                opcodeName: 'TEST',
                variables,
                errors: [],
              },
            };

            const lines = formatTransformSection(result);
            const output = lines.join('\n');

            // All variable names should appear in the output
            for (const variable of variables) {
              assert.ok(
                output.includes(variable.name),
                `Output should contain variable: ${variable.name}`
              );
            }
          }
        ),
        {numRuns: 100}
      );
    });

    it('summarizeVariables produces comma-separated list', () => {
      fc.assert(
        fc.property(
          fc.array(evaluatedVariableArb, {minLength: 1, maxLength: 5}),
          variables => {
            const summary = summarizeVariables(variables);

            // Should contain all variable names (may have duplicates)
            for (const variable of variables) {
              assert.ok(
                summary.includes(variable.name),
                `Summary should contain: ${variable.name}`
              );
            }

            // Should be non-empty for non-empty input
            assert.ok(summary.length > 0, 'Summary should not be empty');

            // Each variable should appear as "name=" in the summary
            for (const variable of variables) {
              assert.ok(
                summary.includes(`${variable.name}=`),
                `Summary should contain "${variable.name}="`
              );
            }
          }
        ),
        {numRuns: 100}
      );
    });
  });

  /**
   * Property 5: Previous Instruction Post-Expressions
   * For any instruction following an instruction with post-expressions,
   * the previous instruction's post-expressions SHALL be displayed with
   * a "Previous Instruction" label.
   *
   * Validates: Requirements 2.3
   */
  describe('Property 5: Previous Instruction Post-Expressions', () => {
    it('updateAddress tracks previous instruction address when stepping', () => {
      fc.assert(
        fc.property(
          fc.integer({min: 0, max: 65535}),
          fc.integer({min: 0, max: 65535}),
          (firstAddress, secondAddress) => {
            // Skip if addresses are the same (no step occurs)
            fc.pre(firstAddress !== secondAddress);

            const provider = new TransformVariableProvider();

            // First update - no previous yet
            provider.updateAddress(firstAddress);
            assert.strictEqual(
              provider.getCurrentAddress(),
              firstAddress,
              'Current address should be set'
            );
            assert.strictEqual(
              provider.getPreviousAddress(),
              -1,
              'Previous address should be -1 initially'
            );

            // Second update - previous should be first address
            provider.updateAddress(secondAddress);
            assert.strictEqual(
              provider.getCurrentAddress(),
              secondAddress,
              'Current address should be updated'
            );
            assert.strictEqual(
              provider.getPreviousAddress(),
              firstAddress,
              'Previous address should be the first address'
            );
          }
        ),
        {numRuns: 100}
      );
    });

    it('hasPreviousPostExpressions returns true when previous transform has post-expressions', () => {
      fc.assert(
        fc.property(
          opcodeTransformArb(-1).filter(t => t.postVariables.length > 0),
          transform => {
            const provider = new TransformVariableProvider();

            // Set up the provider with a previous transform that has post-expressions
            provider.setPreviousTransform(transform);

            assert.strictEqual(
              provider.hasPreviousPostExpressions(),
              true,
              'Should return true when previous transform has post-expressions'
            );
          }
        ),
        {numRuns: 100}
      );
    });

    it('hasPreviousPostExpressions returns false when previous transform has no post-expressions', () => {
      fc.assert(
        fc.property(
          opcodeTransformArb(-1).map(t => ({...t, postVariables: []})),
          transform => {
            const provider = new TransformVariableProvider();

            // Set up the provider with a previous transform that has no post-expressions
            provider.setPreviousTransform(transform);

            assert.strictEqual(
              provider.hasPreviousPostExpressions(),
              false,
              'Should return false when previous transform has no post-expressions'
            );
          }
        ),
        {numRuns: 100}
      );
    });

    it('getTransformVariables returns previous post-expressions with correct group label', () => {
      fc.assert(
        fc.property(
          opcodeTransformArb(-1).filter(t => t.postVariables.length > 0),
          opcodeTransformArb(-1),
          (previousTransform, currentTransform) => {
            const provider = new TransformVariableProvider();

            // Set up the provider with a previous transform
            provider.setPreviousTransform(previousTransform);

            // Get transform variables
            const result = provider.getTransformVariables(currentTransform);

            // Previous post-expressions should be included
            assert.strictEqual(
              result.previousPostVariables.length,
              previousTransform.postVariables.length,
              'Should include all previous post-expressions'
            );

            // All previous post-expressions should have correct group label
            for (const variable of result.previousPostVariables) {
              assert.strictEqual(
                variable.isPreviousInstruction,
                true,
                'Previous post-expressions should be marked as isPreviousInstruction'
              );
              assert.strictEqual(
                variable.group,
                'Previous Instruction',
                'Previous post-expressions should have "Previous Instruction" group'
              );
            }
          }
        ),
        {numRuns: 100}
      );
    });

    it('getTransformVariables returns current pre-expressions with correct group label', () => {
      fc.assert(
        fc.property(
          opcodeTransformArb(-1).filter(t => t.variables.length > 0),
          currentTransform => {
            const provider = new TransformVariableProvider();

            // Get transform variables
            const result = provider.getTransformVariables(currentTransform);

            // Current pre-expressions should be included
            assert.strictEqual(
              result.currentPreVariables.length,
              currentTransform.variables.length,
              'Should include all current pre-expressions'
            );

            // All current pre-expressions should have correct group label
            for (const variable of result.currentPreVariables) {
              assert.strictEqual(
                variable.isPreviousInstruction,
                false,
                'Current pre-expressions should not be marked as isPreviousInstruction'
              );
              assert.strictEqual(
                variable.group,
                'Current Instruction',
                'Current pre-expressions should have "Current Instruction" group'
              );
            }
          }
        ),
        {numRuns: 100}
      );
    });

    it('reset clears all tracked state', () => {
      fc.assert(
        fc.property(
          fc.integer({min: 0, max: 65535}),
          opcodeTransformArb(-1),
          (address, transform) => {
            const provider = new TransformVariableProvider();

            // Set up some state
            provider.updateAddress(address);
            provider.setPreviousTransform(transform);

            // Reset
            provider.reset();

            // All state should be cleared
            assert.strictEqual(
              provider.getCurrentAddress(),
              -1,
              'Current address should be reset to -1'
            );
            assert.strictEqual(
              provider.getPreviousAddress(),
              -1,
              'Previous address should be reset to -1'
            );
            assert.strictEqual(
              provider.getPreviousTransform(),
              null,
              'Previous transform should be reset to null'
            );
            assert.strictEqual(
              provider.hasPreviousPostExpressions(),
              false,
              'hasPreviousPostExpressions should return false after reset'
            );
          }
        ),
        {numRuns: 100}
      );
    });

    it('setTransformLookup callback is used when updating address', () => {
      fc.assert(
        fc.property(
          fc.integer({min: 0, max: 65535}),
          fc.integer({min: 0, max: 65535}),
          opcodeTransformArb(-1),
          (firstAddress, secondAddress, transform) => {
            // Skip if addresses are the same
            fc.pre(firstAddress !== secondAddress);

            const provider = new TransformVariableProvider();

            // Set up a lookup callback that returns the transform for the first address
            let lookupCalled = false;
            let lookupAddress: number | null = null;
            provider.setTransformLookup((addr: number) => {
              lookupCalled = true;
              lookupAddress = addr;
              return addr === firstAddress ? transform : null;
            });

            // First update
            provider.updateAddress(firstAddress);

            // Second update - should trigger lookup for previous address
            provider.updateAddress(secondAddress);

            assert.strictEqual(
              lookupCalled,
              true,
              'Lookup callback should be called'
            );
            assert.strictEqual(
              lookupAddress,
              firstAddress,
              'Lookup should be called with the previous address'
            );
            assert.deepStrictEqual(
              provider.getPreviousTransform(),
              transform,
              'Previous transform should be set from lookup'
            );
          }
        ),
        {numRuns: 100}
      );
    });
  });
});

// ==========================================
// Unit Tests for Edge Cases
// ==========================================

describe('Transform Evaluator Unit Tests', () => {
  describe('formatEvaluatedVariable', () => {
    it('formats simple string value', () => {
      const variable: EvaluatedVariable = {
        name: 'result',
        expression: 'v[p]',
        resolvedExpression: 'v[p]',
        transformedExpression: 'v[p]',
        value: '"hello"',
        type: 'string',
        expandable: false,
        wasTransformed: false,
      };

      const formatted = formatEvaluatedVariable(variable);
      assert.ok(formatted.includes('result'));
      assert.ok(formatted.includes('"hello"'));
    });

    it('formats expandable array with indicator', () => {
      const variable: EvaluatedVariable = {
        name: 'arr',
        expression: 'v[p]',
        resolvedExpression: 'v[p]',
        transformedExpression: 'v[p]',
        value: 'Array(5) [1, 2, ...]',
        type: 'array',
        expandable: true,
        wasTransformed: false,
      };

      const formatted = formatEvaluatedVariable(variable);
      assert.ok(formatted.includes('[+]'));
      assert.ok(formatted.includes('(array)'));
    });

    it('formats error with message', () => {
      const variable: EvaluatedVariable = {
        name: 'bad',
        expression: 'invalid.prop',
        resolvedExpression: 'invalid.prop',
        transformedExpression: 'invalid.prop',
        value: '<error>',
        type: 'error',
        expandable: false,
        error: 'Cannot read property',
        wasTransformed: false,
      };

      const formatted = formatEvaluatedVariable(variable);
      assert.ok(formatted.includes('Error:'));
      assert.ok(formatted.includes('Cannot read property'));
    });

    it('shows expression when option enabled', () => {
      const variable: EvaluatedVariable = {
        name: 'x',
        expression: 'K[0]',
        resolvedExpression: '"hello"',
        transformedExpression: '"hello"',
        value: '"hello"',
        type: 'string',
        expandable: false,
        wasTransformed: false,
      };

      const formatted = formatEvaluatedVariable(variable, {showExpression: true});
      assert.ok(formatted.includes('K[0]'));
      assert.ok(formatted.includes('→'));
    });
  });

  describe('formatTransformOutput', () => {
    it('returns empty string when no transforms', () => {
      const result: TransformEvaluationResult = {
        hasTransforms: false,
      };

      const output = formatTransformOutput(result);
      assert.strictEqual(output, '');
    });

    it('includes previous instruction section when present', () => {
      const result: TransformEvaluationResult = {
        hasTransforms: true,
        previous: {
          opcodeNumber: 10,
          opcodeName: 'PREV',
          postVariables: [
            {
              name: 'postResult',
              expression: 'v[p]',
              resolvedExpression: 'v[p]',
              transformedExpression: 'v[p]',
              value: '42',
              type: 'number',
              expandable: false,
              isPost: true,
              wasTransformed: false,
            },
          ],
        },
      };

      const output = formatTransformOutput(result);
      assert.ok(output.includes('Previous Instruction'));
      assert.ok(output.includes('PREV'));
      assert.ok(output.includes('postResult'));
    });
  });

  describe('summarizeVariables', () => {
    it('returns empty string for empty array', () => {
      const summary = summarizeVariables([]);
      assert.strictEqual(summary, '');
    });

    it('shows <error> for error variables', () => {
      const variables: EvaluatedVariable[] = [
        {
          name: 'bad',
          expression: 'x',
          resolvedExpression: 'x',
          transformedExpression: 'x',
          value: '<error>',
          type: 'error',
          expandable: false,
          error: 'failed',
          wasTransformed: false,
        },
      ];

      const summary = summarizeVariables(variables);
      assert.ok(summary.includes('<error>'));
    });
  });
});

