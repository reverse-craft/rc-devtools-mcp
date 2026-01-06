/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for VM state utility functions.
 *
 * Feature: vmasm-debug-enhancement
 * Tests: formatHexDecimal, formatValue, truncateString
 * Validates: Requirements 1.5, 2.4, 5.3
 */

import {describe, it} from 'node:test';
import * as assert from 'node:assert';
import {
  formatHexDecimal,
  formatValue,
  truncateString,
  isExpandable,
  getTypeName,
} from '../src/utils/vm-state-utils.js';

describe('VM State Utils', () => {
  describe('formatHexDecimal', () => {
    it('formats zero correctly', () => {
      const result = formatHexDecimal(0);
      assert.strictEqual(result, '0x0000 (0)');
    });

    it('formats small numbers with padding', () => {
      const result = formatHexDecimal(255);
      assert.strictEqual(result, '0x00ff (255)');
    });

    it('formats larger numbers correctly', () => {
      const result = formatHexDecimal(11566);
      assert.strictEqual(result, '0x2d2e (11566)');
    });

    it('formats 4-digit hex numbers', () => {
      const result = formatHexDecimal(65535);
      assert.strictEqual(result, '0xffff (65535)');
    });

    it('formats numbers larger than 4 hex digits', () => {
      const result = formatHexDecimal(65536);
      assert.strictEqual(result, '0x10000 (65536)');
    });

    it('returns N/A for NaN', () => {
      const result = formatHexDecimal(NaN);
      assert.strictEqual(result, 'N/A');
    });

    it('returns N/A for Infinity', () => {
      const result = formatHexDecimal(Infinity);
      assert.strictEqual(result, 'N/A');
    });

    it('returns N/A for negative Infinity', () => {
      const result = formatHexDecimal(-Infinity);
      assert.strictEqual(result, 'N/A');
    });
  });

  describe('truncateString', () => {
    it('returns short strings unchanged', () => {
      const result = truncateString('hello', 100);
      assert.strictEqual(result, 'hello');
    });

    it('returns strings at max length unchanged', () => {
      const str = 'a'.repeat(100);
      const result = truncateString(str, 100);
      assert.strictEqual(result, str);
    });

    it('truncates strings longer than max length', () => {
      const str = 'a'.repeat(110);
      const result = truncateString(str, 100);
      assert.strictEqual(result.length, 103); // 100 + '...'
      assert.ok(result.endsWith('...'));
    });

    it('uses default max length of 100', () => {
      const str = 'a'.repeat(110);
      const result = truncateString(str);
      assert.strictEqual(result.length, 103);
    });

    it('handles empty strings', () => {
      const result = truncateString('', 100);
      assert.strictEqual(result, '');
    });
  });

  describe('formatValue', () => {
    it('formats undefined', () => {
      const result = formatValue(undefined);
      assert.strictEqual(result, 'undefined');
    });

    it('formats null', () => {
      const result = formatValue(null);
      assert.strictEqual(result, 'null');
    });

    it('formats strings with quotes', () => {
      const result = formatValue('hello');
      assert.strictEqual(result, '"hello"');
    });

    it('formats numbers', () => {
      const result = formatValue(42);
      assert.strictEqual(result, '42');
    });

    it('formats booleans', () => {
      assert.strictEqual(formatValue(true), 'true');
      assert.strictEqual(formatValue(false), 'false');
    });

    it('formats empty arrays', () => {
      const result = formatValue([]);
      assert.strictEqual(result, 'Array(0) []');
    });

    it('formats arrays with elements', () => {
      const result = formatValue([1, 2, 3]);
      assert.ok(result.startsWith('Array(3)'));
      assert.ok(result.includes('1'));
      assert.ok(result.includes('2'));
      assert.ok(result.includes('3'));
    });

    it('formats large arrays with truncation', () => {
      const arr = Array.from({length: 100}, (_, i) => i);
      const result = formatValue(arr);
      assert.ok(result.startsWith('Array(100)'));
      assert.ok(result.includes('...'));
    });

    it('formats empty objects', () => {
      const result = formatValue({});
      assert.strictEqual(result, '{}');
    });

    it('formats objects with properties', () => {
      const result = formatValue({a: 1, b: 2});
      assert.ok(result.includes('a:'));
      assert.ok(result.includes('b:'));
    });

    it('formats functions', () => {
      const result = formatValue(() => {});
      assert.strictEqual(result, '[Function]');
    });

    it('truncates long strings', () => {
      const longStr = 'a'.repeat(200);
      const result = formatValue(longStr, 50);
      assert.ok(result.length <= 53); // 50 + '...'
    });
  });

  describe('isExpandable', () => {
    it('returns false for null', () => {
      assert.strictEqual(isExpandable(null), false);
    });

    it('returns false for undefined', () => {
      assert.strictEqual(isExpandable(undefined), false);
    });

    it('returns false for primitives', () => {
      assert.strictEqual(isExpandable(42), false);
      assert.strictEqual(isExpandable('hello'), false);
      assert.strictEqual(isExpandable(true), false);
    });

    it('returns false for empty arrays', () => {
      assert.strictEqual(isExpandable([]), false);
    });

    it('returns true for non-empty arrays', () => {
      assert.strictEqual(isExpandable([1, 2, 3]), true);
    });

    it('returns false for empty objects', () => {
      assert.strictEqual(isExpandable({}), false);
    });

    it('returns true for non-empty objects', () => {
      assert.strictEqual(isExpandable({a: 1}), true);
    });
  });

  describe('getTypeName', () => {
    it('returns "null" for null', () => {
      assert.strictEqual(getTypeName(null), 'null');
    });

    it('returns "undefined" for undefined', () => {
      assert.strictEqual(getTypeName(undefined), 'undefined');
    });

    it('returns "number" for numbers', () => {
      assert.strictEqual(getTypeName(42), 'number');
    });

    it('returns "string" for strings', () => {
      assert.strictEqual(getTypeName('hello'), 'string');
    });

    it('returns "boolean" for booleans', () => {
      assert.strictEqual(getTypeName(true), 'boolean');
    });

    it('returns "array" for arrays', () => {
      assert.strictEqual(getTypeName([1, 2, 3]), 'array');
    });

    it('returns "Object" for plain objects', () => {
      assert.strictEqual(getTypeName({}), 'Object');
    });

    it('returns constructor name for class instances', () => {
      assert.strictEqual(getTypeName(new Date()), 'Date');
      assert.strictEqual(getTypeName(new Map()), 'Map');
    });
  });
});
