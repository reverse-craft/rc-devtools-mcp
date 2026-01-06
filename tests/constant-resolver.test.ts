/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for constant resolver utility functions.
 *
 * Feature: vmasm-debug-enhancement
 * Tests: resolveConstantReferences, hasConstantReferences, extractConstantIndices
 * Validates: Requirements 2.4, 6.5
 */

import {describe, it} from 'node:test';
import * as assert from 'node:assert';
import type {ConstantEntry} from '../src/utils/vmasm-visitor.js';
import {
  resolveConstantReferences,
  hasConstantReferences,
  extractConstantIndices,
  getConstantAtIndex,
  formatConstantInline,
  resolveSingleReference,
} from '../src/utils/constant-resolver.js';

// Test fixtures
const TEST_CONSTANTS: ConstantEntry[] = [
  {index: 0, type: 'String', value: 'hello'},
  {index: 1, type: 'Number', value: 42},
  {index: 2, type: 'Boolean', value: true},
  {index: 3, type: 'Null', value: null},
  {index: 4, type: 'Object', value: '{key: "value"}'},
  {index: 5, type: 'String', value: 'world'},
];

describe('Constant Resolver', () => {
  describe('resolveConstantReferences', () => {
    it('resolves single string constant', () => {
      const result = resolveConstantReferences('K[0]', TEST_CONSTANTS);
      assert.strictEqual(result.resolved, '"hello"');
      assert.strictEqual(result.hasReferences, true);
      assert.deepStrictEqual(result.resolvedIndices, [0]);
      assert.deepStrictEqual(result.invalidIndices, []);
    });

    it('resolves single number constant', () => {
      const result = resolveConstantReferences('K[1]', TEST_CONSTANTS);
      assert.strictEqual(result.resolved, '42');
      assert.strictEqual(result.hasReferences, true);
      assert.deepStrictEqual(result.resolvedIndices, [1]);
    });

    it('resolves boolean constant', () => {
      const result = resolveConstantReferences('K[2]', TEST_CONSTANTS);
      assert.strictEqual(result.resolved, 'true');
    });

    it('resolves null constant', () => {
      const result = resolveConstantReferences('K[3]', TEST_CONSTANTS);
      assert.strictEqual(result.resolved, 'null');
    });

    it('resolves object constant', () => {
      const result = resolveConstantReferences('K[4]', TEST_CONSTANTS);
      assert.strictEqual(result.resolved, '{key: "value"}');
    });

    it('resolves multiple constants in expression', () => {
      const result = resolveConstantReferences('K[0] + K[1]', TEST_CONSTANTS);
      assert.strictEqual(result.resolved, '"hello" + 42');
      assert.deepStrictEqual(result.resolvedIndices, [0, 1]);
    });

    it('handles expressions without constants', () => {
      const result = resolveConstantReferences('a + b', TEST_CONSTANTS);
      assert.strictEqual(result.resolved, 'a + b');
      assert.strictEqual(result.hasReferences, false);
      assert.deepStrictEqual(result.resolvedIndices, []);
    });

    it('handles invalid constant indices', () => {
      const result = resolveConstantReferences('K[99]', TEST_CONSTANTS);
      assert.strictEqual(result.resolved, 'K[99]'); // Unchanged
      assert.strictEqual(result.hasReferences, true);
      assert.deepStrictEqual(result.invalidIndices, [99]);
    });

    it('handles mixed valid and invalid indices', () => {
      const result = resolveConstantReferences('K[0] + K[99]', TEST_CONSTANTS);
      assert.strictEqual(result.resolved, '"hello" + K[99]');
      assert.deepStrictEqual(result.resolvedIndices, [0]);
      assert.deepStrictEqual(result.invalidIndices, [99]);
    });

    it('handles complex expressions', () => {
      const result = resolveConstantReferences(
        'v[p - 1] === K[0] && v[p] === K[1]',
        TEST_CONSTANTS
      );
      assert.strictEqual(result.resolved, 'v[p - 1] === "hello" && v[p] === 42');
    });

    it('handles empty expression', () => {
      const result = resolveConstantReferences('', TEST_CONSTANTS);
      assert.strictEqual(result.resolved, '');
      assert.strictEqual(result.hasReferences, false);
    });

    it('handles empty constants array', () => {
      const result = resolveConstantReferences('K[0]', []);
      assert.strictEqual(result.resolved, 'K[0]');
      assert.deepStrictEqual(result.invalidIndices, [0]);
    });
  });

  describe('hasConstantReferences', () => {
    it('returns true for expressions with K[n]', () => {
      assert.strictEqual(hasConstantReferences('K[0]'), true);
      assert.strictEqual(hasConstantReferences('a + K[1]'), true);
      assert.strictEqual(hasConstantReferences('K[0] + K[1]'), true);
    });

    it('returns false for expressions without K[n]', () => {
      assert.strictEqual(hasConstantReferences('a + b'), false);
      assert.strictEqual(hasConstantReferences(''), false);
      assert.strictEqual(hasConstantReferences('K'), false);
      assert.strictEqual(hasConstantReferences('K[]'), false);
    });
  });

  describe('extractConstantIndices', () => {
    it('extracts single index', () => {
      const indices = extractConstantIndices('K[0]');
      assert.deepStrictEqual(indices, [0]);
    });

    it('extracts multiple indices', () => {
      const indices = extractConstantIndices('K[0] + K[1] + K[2]');
      assert.deepStrictEqual(indices, [0, 1, 2]);
    });

    it('extracts duplicate indices', () => {
      const indices = extractConstantIndices('K[0] + K[0]');
      assert.deepStrictEqual(indices, [0, 0]);
    });

    it('returns empty array for no references', () => {
      const indices = extractConstantIndices('a + b');
      assert.deepStrictEqual(indices, []);
    });

    it('handles large indices', () => {
      const indices = extractConstantIndices('K[999]');
      assert.deepStrictEqual(indices, [999]);
    });
  });

  describe('getConstantAtIndex', () => {
    it('returns constant at valid index', () => {
      const constant = getConstantAtIndex(0, TEST_CONSTANTS);
      assert.deepStrictEqual(constant, {index: 0, type: 'String', value: 'hello'});
    });

    it('returns undefined for invalid index', () => {
      const constant = getConstantAtIndex(99, TEST_CONSTANTS);
      assert.strictEqual(constant, undefined);
    });

    it('returns undefined for empty array', () => {
      const constant = getConstantAtIndex(0, []);
      assert.strictEqual(constant, undefined);
    });
  });

  describe('formatConstantInline', () => {
    it('formats string constants with quotes', () => {
      const result = formatConstantInline({index: 0, type: 'String', value: 'hello'});
      assert.strictEqual(result, '"hello"');
    });

    it('truncates long strings', () => {
      const longStr = 'a'.repeat(50);
      const result = formatConstantInline({index: 0, type: 'String', value: longStr}, 30);
      assert.ok(result.length <= 30);
      assert.ok(result.includes('...'));
    });

    it('formats number constants', () => {
      const result = formatConstantInline({index: 0, type: 'Number', value: 42});
      assert.strictEqual(result, '42');
    });

    it('formats boolean constants', () => {
      assert.strictEqual(
        formatConstantInline({index: 0, type: 'Boolean', value: true}),
        'true'
      );
      assert.strictEqual(
        formatConstantInline({index: 0, type: 'Boolean', value: false}),
        'false'
      );
    });

    it('formats null constants', () => {
      const result = formatConstantInline({index: 0, type: 'Null', value: null});
      assert.strictEqual(result, 'null');
    });
  });

  describe('resolveSingleReference', () => {
    it('resolves valid K[n] reference', () => {
      const result = resolveSingleReference('K[0]', TEST_CONSTANTS);
      assert.strictEqual(result, '"hello"');
    });

    it('returns original for invalid index', () => {
      const result = resolveSingleReference('K[99]', TEST_CONSTANTS);
      assert.strictEqual(result, 'K[99]');
    });

    it('returns original for non-K[n] strings', () => {
      const result = resolveSingleReference('hello', TEST_CONSTANTS);
      assert.strictEqual(result, 'hello');
    });

    it('returns original for malformed K references', () => {
      assert.strictEqual(resolveSingleReference('K[]', TEST_CONSTANTS), 'K[]');
      assert.strictEqual(resolveSingleReference('K[abc]', TEST_CONSTANTS), 'K[abc]');
    });
  });
});
