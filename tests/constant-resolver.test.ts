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
  resolveConstantReferencesWithErrors,
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

// Test fixtures for nested references (Requirements 4.1, 4.2)
const NESTED_CONSTANTS: ConstantEntry[] = [
  {index: 0, type: 'String', value: 'hello'},
  {index: 1, type: 'Number', value: 42},
  {index: 2, type: 'Number', value: 0},  // K[2] = 0, so K[K[2]] = K[0] = "hello"
  {index: 3, type: 'Number', value: 1},  // K[3] = 1, so K[K[3]] = K[1] = 42
  {index: 4, type: 'Number', value: 2},  // K[4] = 2, so K[K[4]] = K[2] = 0
  {index: 5, type: 'Object', value: '{"a":1,"b":2}'},  // JSON object
  {index: 6, type: 'Object', value: '[1,2,3]'},  // JSON array
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

    it('shows error indicator for invalid index when enabled (Requirement 4.5)', () => {
      const result = resolveSingleReference('K[99]', TEST_CONSTANTS, true);
      assert.strictEqual(result, 'K[99] <out of bounds>');
    });
  });

  // Requirements 4.1, 4.2: Nested K[K[n]] reference resolution
  describe('nested K[K[n]] references (Requirements 4.1, 4.2)', () => {
    it('resolves simple nested K[K[n]] reference', () => {
      // K[2] = 0, so K[K[2]] = K[0] = "hello"
      const result = resolveConstantReferences('K[K[2]]', NESTED_CONSTANTS);
      assert.strictEqual(result.resolved, '"hello"');
      assert.strictEqual(result.hasReferences, true);
      assert.ok(result.resolvedIndices.includes(2));
      assert.ok(result.resolvedIndices.includes(0));
    });

    it('resolves nested reference to number constant', () => {
      // K[3] = 1, so K[K[3]] = K[1] = 42
      const result = resolveConstantReferences('K[K[3]]', NESTED_CONSTANTS);
      assert.strictEqual(result.resolved, '42');
    });

    it('resolves multiple nested references in expression', () => {
      // K[K[2]] + K[K[3]] = K[0] + K[1] = "hello" + 42
      const result = resolveConstantReferences('K[K[2]] + K[K[3]]', NESTED_CONSTANTS);
      assert.strictEqual(result.resolved, '"hello" + 42');
    });

    it('handles nested reference with invalid inner index', () => {
      const result = resolveConstantReferences('K[K[99]]', NESTED_CONSTANTS);
      assert.strictEqual(result.resolved, 'K[K[99]]');
      assert.ok(result.invalidIndices.includes(99));
    });

    it('handles nested reference with invalid outer index', () => {
      // K[4] = 2, K[2] = 0, but if we had K[K[4]] where K[4] points to invalid
      // Let's create a case where inner resolves but outer is invalid
      const constants: ConstantEntry[] = [
        {index: 0, type: 'Number', value: 99},  // K[0] = 99, K[K[0]] = K[99] = invalid
      ];
      const result = resolveConstantReferences('K[K[0]]', constants);
      assert.strictEqual(result.resolved, 'K[99]');
      assert.ok(result.invalidIndices.includes(99));
    });

    it('handles non-numeric inner value gracefully', () => {
      // K[0] = "hello" (string), so K[K[0]] can't use "hello" as index
      const result = resolveConstantReferences('K[K[0]]', NESTED_CONSTANTS);
      // Should return K["hello"] since "hello" is not a valid index
      assert.strictEqual(result.resolved, 'K["hello"]');
    });

    it('mixes nested and simple references', () => {
      // K[K[2]] + K[1] = K[0] + K[1] = "hello" + 42
      const result = resolveConstantReferences('K[K[2]] + K[1]', NESTED_CONSTANTS);
      assert.strictEqual(result.resolved, '"hello" + 42');
    });
  });

  // Requirements 4.3, 4.4: String constants with quotes and object/array previews
  describe('constant formatting (Requirements 4.3, 4.4)', () => {
    it('formats string constants with quotes (Requirement 4.3)', () => {
      const result = resolveConstantReferences('K[0]', NESTED_CONSTANTS);
      assert.strictEqual(result.resolved, '"hello"');
    });

    it('formats JSON object constants (Requirement 4.4)', () => {
      const result = resolveConstantReferences('K[5]', NESTED_CONSTANTS);
      // Should parse and format the JSON object
      assert.strictEqual(result.resolved, '{"a":1,"b":2}');
    });

    it('formats JSON array constants (Requirement 4.4)', () => {
      const result = resolveConstantReferences('K[6]', NESTED_CONSTANTS);
      // Should parse and format the JSON array
      assert.strictEqual(result.resolved, '[1,2,3]');
    });

    it('truncates long object previews', () => {
      const longObjConstants: ConstantEntry[] = [
        {index: 0, type: 'Object', value: '{"key1":"value1","key2":"value2","key3":"value3","key4":"value4","key5":"value5"}'},
      ];
      const result = resolveConstantReferences('K[0]', longObjConstants);
      // Should be truncated with preview info
      assert.ok(result.resolved.length <= 60 || result.resolved.includes('...'));
    });
  });

  // Requirement 4.5: Out-of-bounds error indicator
  describe('out-of-bounds error indicator (Requirement 4.5)', () => {
    it('shows error indicator when enabled', () => {
      const result = resolveConstantReferences('K[99]', TEST_CONSTANTS, {showErrorIndicator: true});
      assert.strictEqual(result.resolved, 'K[99] <out of bounds>');
      assert.ok(result.invalidIndices.includes(99));
    });

    it('does not show error indicator by default', () => {
      const result = resolveConstantReferences('K[99]', TEST_CONSTANTS);
      assert.strictEqual(result.resolved, 'K[99]');
    });

    it('shows error indicator for nested reference with invalid outer index', () => {
      const constants: ConstantEntry[] = [
        {index: 0, type: 'Number', value: 99},  // K[0] = 99, K[K[0]] = K[99] = invalid
      ];
      const result = resolveConstantReferences('K[K[0]]', constants, {showErrorIndicator: true});
      assert.strictEqual(result.resolved, 'K[99] <out of bounds>');
    });

    it('resolveConstantReferencesWithErrors convenience function shows error indicators', () => {
      const result = resolveConstantReferencesWithErrors('K[99]', TEST_CONSTANTS);
      assert.strictEqual(result.resolved, 'K[99] <out of bounds>');
    });
  });
});
