/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for AST transform utility functions.
 *
 * Feature: vm-state-ast-transform
 * Tests: IdentifierSubstitutor, substituteIdentifiers
 * Validates: Requirements 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 5.1
 */

import {describe, it} from 'node:test';
import * as assert from 'node:assert';
import {
  IdentifierSubstitutor,
  substituteIdentifiers,
  type RegisterMapping,
} from '../src/utils/ast-transform.js';

// Test fixtures
const TEST_MAPPING: RegisterMapping = {
  stack: 'v',
  sp: 'p',
  ip: 'a',
  bc: 'o',
  storage: 's',
  const: 'K',
  scope: 'c',
};

describe('AST Transform', () => {
  describe('IdentifierSubstitutor', () => {
    describe('substituteIdentifiers', () => {
      it('substitutes simple identifier', () => {
        const substitutor = new IdentifierSubstitutor();
        const result = substitutor.substituteIdentifiers('stack', TEST_MAPPING);

        assert.strictEqual(result.transformed, 'v');
        assert.strictEqual(result.wasTransformed, true);
        assert.strictEqual(result.substitutions.length, 1);
        assert.strictEqual(result.substitutions[0].original, 'stack');
        assert.strictEqual(result.substitutions[0].replacement, 'v');
      });

      it('substitutes array access expression', () => {
        const substitutor = new IdentifierSubstitutor();
        const result = substitutor.substituteIdentifiers('stack[sp]', TEST_MAPPING);

        assert.strictEqual(result.transformed, 'v[p]');
        assert.strictEqual(result.wasTransformed, true);
        assert.strictEqual(result.substitutions.length, 2);
      });

      it('substitutes complex expression with arithmetic', () => {
        const substitutor = new IdentifierSubstitutor();
        const result = substitutor.substituteIdentifiers(
          'stack[sp - bc[ip + 1]]',
          TEST_MAPPING
        );

        assert.strictEqual(result.transformed, 'v[p - o[a + 1]]');
        assert.strictEqual(result.wasTransformed, true);
      });

      it('preserves property names in member expressions (Requirement 2.4)', () => {
        const substitutor = new IdentifierSubstitutor();
        const result = substitutor.substituteIdentifiers('obj.stack', TEST_MAPPING);

        // 'stack' as property name should NOT be replaced
        assert.strictEqual(result.transformed, 'obj.stack');
        assert.strictEqual(result.wasTransformed, false);
      });

      it('replaces computed property access', () => {
        const substitutor = new IdentifierSubstitutor();
        const result = substitutor.substituteIdentifiers('obj[stack]', TEST_MAPPING);

        // 'stack' as computed property should be replaced
        assert.strictEqual(result.transformed, 'obj[v]');
        assert.strictEqual(result.wasTransformed, true);
      });

      it('preserves string literals (Requirement 2.5)', () => {
        const substitutor = new IdentifierSubstitutor();
        const result = substitutor.substituteIdentifiers('"stack"', TEST_MAPPING);

        // 'stack' inside string should NOT be replaced
        assert.strictEqual(result.transformed, '"stack"');
        assert.strictEqual(result.wasTransformed, false);
      });

      it('handles nested function calls (Requirement 2.6)', () => {
        const substitutor = new IdentifierSubstitutor();
        const result = substitutor.substituteIdentifiers(
          'fn(stack[sp], bc[ip])',
          TEST_MAPPING
        );

        assert.strictEqual(result.transformed, 'fn(v[p], o[a])');
        assert.strictEqual(result.wasTransformed, true);
      });

      it('returns original expression for empty input', () => {
        const substitutor = new IdentifierSubstitutor();
        const result = substitutor.substituteIdentifiers('', TEST_MAPPING);

        assert.strictEqual(result.transformed, '');
        assert.strictEqual(result.wasTransformed, false);
        assert.strictEqual(result.substitutions.length, 0);
      });

      it('returns original expression when no mappings provided', () => {
        const substitutor = new IdentifierSubstitutor();
        const result = substitutor.substituteIdentifiers('stack[sp]', {});

        assert.strictEqual(result.transformed, 'stack[sp]');
        assert.strictEqual(result.wasTransformed, false);
      });

      it('handles expressions with no matching identifiers', () => {
        const substitutor = new IdentifierSubstitutor();
        const result = substitutor.substituteIdentifiers('x + y', TEST_MAPPING);

        assert.strictEqual(result.transformed, 'x + y');
        assert.strictEqual(result.wasTransformed, false);
      });

      it('skips object property keys', () => {
        const substitutor = new IdentifierSubstitutor();
        // Use different key and value to clearly test the behavior
        const result = substitutor.substituteIdentifiers(
          '{ myKey: stack }',
          TEST_MAPPING
        );

        // Key 'myKey' should NOT be replaced, value 'stack' should be replaced to 'v'
        assert.ok(result.transformed.includes('myKey'));
        assert.ok(result.transformed.includes('v'));
        assert.strictEqual(result.wasTransformed, true);
        assert.strictEqual(result.substitutions.length, 1);
        assert.strictEqual(result.substitutions[0].original, 'stack');
        assert.strictEqual(result.substitutions[0].replacement, 'v');
      });
    });

    describe('fallback handling for parsing errors (Requirements 2.7, 5.1)', () => {
      it('returns original expression on parse failure', () => {
        const substitutor = new IdentifierSubstitutor();
        // Invalid JavaScript syntax
        const invalidExpression = 'stack[sp +++ invalid';
        const result = substitutor.substituteIdentifiers(
          invalidExpression,
          TEST_MAPPING
        );

        // Should return original expression unchanged
        assert.strictEqual(result.original, invalidExpression);
        assert.strictEqual(result.transformed, invalidExpression);
        assert.strictEqual(result.wasTransformed, false);
        assert.strictEqual(result.substitutions.length, 0);
      });

      it('includes error message on parse failure', () => {
        const substitutor = new IdentifierSubstitutor();
        const invalidExpression = '{ unclosed: ';
        const result = substitutor.substituteIdentifiers(
          invalidExpression,
          TEST_MAPPING
        );

        // Should have error message
        assert.ok(result.error, 'Should have error message');
        assert.ok(result.error.length > 0, 'Error message should not be empty');
      });

      it('handles completely malformed expressions', () => {
        const substitutor = new IdentifierSubstitutor();
        const malformedExpressions = [
          '(((',
          '))))',
          'function {',
          'class extends',
          '=> =>'
        ];

        for (const expr of malformedExpressions) {
          const result = substitutor.substituteIdentifiers(expr, TEST_MAPPING);

          // Should return original expression unchanged
          assert.strictEqual(
            result.transformed,
            expr,
            `Should return original for: ${expr}`
          );
          assert.strictEqual(
            result.wasTransformed,
            false,
            `Should not be transformed for: ${expr}`
          );
          assert.ok(
            result.error,
            `Should have error for: ${expr}`
          );
        }
      });

      it('continues processing after parse error', () => {
        const substitutor = new IdentifierSubstitutor();

        // First call with invalid expression
        const invalidResult = substitutor.substituteIdentifiers(
          'invalid +++',
          TEST_MAPPING
        );
        assert.ok(invalidResult.error);

        // Second call with valid expression should work
        const validResult = substitutor.substituteIdentifiers(
          'stack[sp]',
          TEST_MAPPING
        );
        assert.strictEqual(validResult.transformed, 'v[p]');
        assert.strictEqual(validResult.wasTransformed, true);
        assert.strictEqual(validResult.error, undefined);
      });
    });
  });

  describe('substituteIdentifiers convenience function', () => {
    it('works as a convenience wrapper', () => {
      const result = substituteIdentifiers('stack[sp]', TEST_MAPPING);

      assert.strictEqual(result.transformed, 'v[p]');
      assert.strictEqual(result.wasTransformed, true);
    });

    it('handles parse errors gracefully', () => {
      const result = substituteIdentifiers('invalid +++', TEST_MAPPING);

      assert.strictEqual(result.transformed, 'invalid +++');
      assert.strictEqual(result.wasTransformed, false);
      assert.ok(result.error);
    });
  });
});
