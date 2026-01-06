/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Property-based tests for VM state output completeness.
 *
 * Feature: vmasm-debug-enhancement
 * Property 1: Output Section Completeness
 * Validates: Requirements 1.1, 2.1, 3.1, 4.1, 5.4
 *
 * For any paused debugger state with a loaded vmasm file, the get_vm_state
 * output SHALL contain all required sections: "JSVMP Registers", "JSVMP Transform"
 * (if transforms exist), "JSVMP Call Stack", and scope sections (if available).
 */

import {describe, it, beforeEach, afterEach} from 'node:test';
import * as assert from 'node:assert';
import fc from 'fast-check';
import {
  formatHexDecimal,
  formatValue,
  isExpandable,
  getTypeName,
  truncateString,
} from '../src/utils/vm-state-utils.js';
import {
  formatTransformSection,
  type TransformEvaluationResult,
  type EvaluatedVariable,
} from '../src/utils/transform-evaluator.js';
import {
  formatCallStackSection,
  type VirtualCallStack,
  type JsvmpFrame,
} from '../src/utils/virtual-call-stack.js';
import {
  formatAllScopes,
  formatScopeSection,
  hasScopeVariables,
  type ScopeData,
  type ScopeVariable,
} from '../src/utils/scope-fetcher.js';

// ==========================================
// Generators for property-based testing
// ==========================================

/**
 * Generate a valid numeric value for addresses
 */
const addressArb = fc.integer({min: 0, max: 65535});

/**
 * Generate a valid opcode name
 */
const opcodeNameArb = fc.stringMatching(/^[A-Z][A-Z_]{0,10}$/);

/**
 * Generate a variable name
 */
const variableNameArb = fc.stringMatching(/^[a-z][a-zA-Z0-9_]{0,10}$/);

/**
 * Generate a JavaScript value for testing
 */
const jsValueArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({minLength: 0, maxLength: 50}),
  fc.integer({min: -1000000, max: 1000000}),
  fc.boolean(),
  fc.constant(null),
  fc.constant(undefined),
  fc.array(fc.integer({min: 0, max: 100}), {minLength: 0, maxLength: 10}),
  fc.dictionary(
    fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,5}$/),
    fc.integer({min: 0, max: 100}),
    {minKeys: 0, maxKeys: 5}
  )
);

/**
 * Generate an evaluated variable
 */
const evaluatedVariableArb: fc.Arbitrary<EvaluatedVariable> = fc.record({
  name: variableNameArb,
  expression: fc.string({minLength: 1, maxLength: 30}),
  resolvedExpression: fc.string({minLength: 1, maxLength: 30}),
  value: fc.string({minLength: 1, maxLength: 50}),
  type: fc.constantFrom('string', 'number', 'boolean', 'object', 'array', 'null', 'undefined'),
  expandable: fc.boolean(),
  error: fc.option(fc.string({minLength: 1, maxLength: 30}), {nil: undefined}),
  isPost: fc.option(fc.boolean(), {nil: undefined}),
});

/**
 * Generate a transform evaluation result
 */
const transformResultArb: fc.Arbitrary<TransformEvaluationResult> = fc.record({
  hasTransforms: fc.boolean(),
  current: fc.option(
    fc.record({
      opcodeNumber: fc.integer({min: 0, max: 255}),
      opcodeName: opcodeNameArb,
      variables: fc.array(evaluatedVariableArb, {minLength: 0, maxLength: 5}),
      errors: fc.array(fc.string({minLength: 1, maxLength: 30}), {minLength: 0, maxLength: 3}),
    }),
    {nil: undefined}
  ),
  previous: fc.option(
    fc.record({
      opcodeNumber: fc.integer({min: 0, max: 255}),
      opcodeName: opcodeNameArb,
      postVariables: fc.array(evaluatedVariableArb, {minLength: 0, maxLength: 3}),
    }),
    {nil: undefined}
  ),
});

/**
 * Generate a JSVMP frame
 */
const jsvmpFrameArb: fc.Arbitrary<JsvmpFrame> = fc.record({
  jsFrameIndex: fc.integer({min: 0, max: 20}),
  cdpCallFrameId: fc.string({minLength: 5, maxLength: 20}),
  virtualIp: addressArb,
  rawIp: addressArb,
  offset: fc.integer({min: 0, max: 10000}),
  sp: fc.option(fc.integer({min: 0, max: 100}), {nil: undefined}),
  vmasmLine: fc.option(fc.integer({min: 1, max: 1000}), {nil: undefined}),
  opcodeName: fc.option(opcodeNameArb, {nil: undefined}),
  functionName: fc.option(fc.string({minLength: 1, maxLength: 20}), {nil: undefined}),
});

/**
 * Generate a virtual call stack with consistent frame count
 */
const virtualCallStackArb: fc.Arbitrary<VirtualCallStack> = fc.array(jsvmpFrameArb, {minLength: 0, maxLength: 10})
  .chain(frames => fc.record({
    frames: fc.constant(frames),
    totalJsFrames: fc.integer({min: frames.length, max: 50}),
    jsvmpFrameCount: fc.constant(frames.length), // Must match actual frame count
    errors: fc.array(fc.string({minLength: 1, maxLength: 50}), {minLength: 0, maxLength: 3}),
  }));

/**
 * Generate a scope variable
 */
const scopeVariableArb: fc.Arbitrary<ScopeVariable> = fc.record({
  name: variableNameArb,
  value: fc.string({minLength: 1, maxLength: 50}),
  type: fc.constantFrom('string', 'number', 'boolean', 'object', 'array', 'null', 'undefined', 'function'),
  expandable: fc.boolean(),
});

/**
 * Generate scope data
 */
const scopeDataArb: fc.Arbitrary<ScopeData> = fc.record({
  local: fc.array(scopeVariableArb, {minLength: 0, maxLength: 10}),
  closure: fc.array(scopeVariableArb, {minLength: 0, maxLength: 5}),
  global: fc.array(scopeVariableArb, {minLength: 0, maxLength: 5}),
});

// ==========================================
// Property Tests
// ==========================================

describe('VM State Output Property Tests', () => {
  /**
   * Property 1: Output Section Completeness
   * For any paused debugger state with a loaded vmasm file, the get_vm_state
   * output SHALL contain all required sections.
   *
   * Validates: Requirements 1.1, 2.1, 3.1, 4.1, 5.4
   */
  describe('Property 1: Output Section Completeness', () => {
    it('formatHexDecimal produces valid hex and decimal format for all addresses', () => {
      fc.assert(
        fc.property(addressArb, (address) => {
          const result = formatHexDecimal(address);

          // Should contain hex format (0x followed by at least 4 hex digits)
          assert.ok(
            /0x[0-9a-f]{4,}/i.test(result),
            `Result should contain hex format: ${result}`
          );

          // Should contain decimal in parentheses
          assert.ok(
            result.includes(`(${address})`),
            `Result should contain decimal value: ${result}`
          );

          return true;
        }),
        {numRuns: 100}
      );
    });

    it('formatValue handles all JavaScript value types', () => {
      fc.assert(
        fc.property(jsValueArb, (value) => {
          const result = formatValue(value);

          // Result should be a non-empty string
          assert.ok(
            typeof result === 'string' && result.length > 0,
            `Result should be non-empty string: ${result}`
          );

          // Result should not throw
          return true;
        }),
        {numRuns: 100}
      );
    });

    it('truncateString respects maxLength for all strings', () => {
      fc.assert(
        fc.property(
          fc.string({minLength: 0, maxLength: 500}),
          fc.integer({min: 10, max: 200}),
          (str, maxLength) => {
            const result = truncateString(str, maxLength);

            if (str.length <= maxLength) {
              // Should not be truncated
              assert.strictEqual(result, str, 'Short strings should not be truncated');
            } else {
              // Should be truncated with ...
              assert.ok(
                result.length <= maxLength + 3, // maxLength + "..."
                `Truncated string should be at most maxLength + 3: ${result.length}`
              );
              assert.ok(
                result.endsWith('...'),
                'Truncated string should end with ...'
              );
            }

            return true;
          }
        ),
        {numRuns: 100}
      );
    });

    it('isExpandable correctly identifies expandable values', () => {
      fc.assert(
        fc.property(jsValueArb, (value) => {
          const result = isExpandable(value);

          // Result should be a boolean
          assert.ok(
            typeof result === 'boolean',
            'isExpandable should return boolean'
          );

          // Arrays with elements should be expandable
          if (Array.isArray(value) && value.length > 0) {
            assert.strictEqual(result, true, 'Non-empty arrays should be expandable');
          }

          // Objects with properties should be expandable
          if (
            value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Object.keys(value).length > 0
          ) {
            assert.strictEqual(result, true, 'Non-empty objects should be expandable');
          }

          // Primitives should not be expandable
          if (value === null || value === undefined || typeof value !== 'object') {
            assert.strictEqual(result, false, 'Primitives should not be expandable');
          }

          return true;
        }),
        {numRuns: 100}
      );
    });

    it('getTypeName returns valid type names for all values', () => {
      fc.assert(
        fc.property(jsValueArb, (value) => {
          const result = getTypeName(value);

          // Result should be a non-empty string
          assert.ok(
            typeof result === 'string' && result.length > 0,
            `Type name should be non-empty string: ${result}`
          );

          // Should match expected type names
          const validTypes = [
            'string', 'number', 'boolean', 'null', 'undefined',
            'object', 'array', 'function', 'symbol', 'bigint',
            'Object', 'Array', 'Date', 'RegExp', 'Error', 'Map', 'Set'
          ];

          // Type should be recognizable (either in validTypes or a constructor name)
          assert.ok(
            validTypes.includes(result) || /^[A-Z][a-zA-Z]*$/.test(result),
            `Type name should be valid: ${result}`
          );

          return true;
        }),
        {numRuns: 100}
      );
    });

    it('formatTransformSection produces valid output for all transform results', () => {
      fc.assert(
        fc.property(transformResultArb, (result) => {
          const lines = formatTransformSection(result);

          // Result should be an array
          assert.ok(Array.isArray(lines), 'Result should be an array');

          // If hasTransforms is false, should return empty array
          if (!result.hasTransforms) {
            assert.strictEqual(lines.length, 0, 'No transforms should produce empty array');
            return true;
          }

          // If has current transform with variables, should have content
          if (result.current && result.current.variables.length > 0) {
            assert.ok(lines.length > 0, 'Transform with variables should produce output');

            // Should contain opcode name
            const hasOpcodeName = lines.some(line =>
              line.includes(result.current!.opcodeName)
            );
            assert.ok(hasOpcodeName, 'Output should contain opcode name');
          }

          // All lines should be strings
          for (const line of lines) {
            assert.ok(typeof line === 'string', 'All lines should be strings');
          }

          return true;
        }),
        {numRuns: 100}
      );
    });

    it('formatCallStackSection produces valid output for all call stacks', () => {
      fc.assert(
        fc.property(virtualCallStackArb, (callStack) => {
          const lines = formatCallStackSection(callStack);

          // Result should be an array
          assert.ok(Array.isArray(lines), 'Result should be an array');

          // Should always have at least the header
          assert.ok(lines.length > 0, 'Should have at least header line');

          // First line should be the header with emoji
          assert.ok(
            lines[0].includes('JSVMP Call Stack'),
            'First line should be call stack header'
          );

          // If no frames, should indicate that
          if (callStack.jsvmpFrameCount === 0 && callStack.errors.length === 0) {
            const hasNoFramesMessage = lines.some(line =>
              line.includes('No JSVMP frames detected')
            );
            assert.ok(hasNoFramesMessage, 'Should indicate no frames detected');
          }

          // If has frames, should show them
          if (callStack.frames.length > 0) {
            // Should show depth
            const hasDepth = lines.some(line => line.includes('Depth:'));
            assert.ok(hasDepth, 'Should show depth when frames exist');
          }

          return true;
        }),
        {numRuns: 100}
      );
    });

    it('formatAllScopes produces valid output for all scope data', () => {
      fc.assert(
        fc.property(scopeDataArb, (scopeData) => {
          const lines = formatAllScopes(scopeData);

          // Result should be an array
          assert.ok(Array.isArray(lines), 'Result should be an array');

          // If has local variables, should have Local section
          if (scopeData.local.length > 0) {
            const hasLocalSection = lines.some(line =>
              line.includes('Local Scope')
            );
            assert.ok(hasLocalSection, 'Should have Local Scope section');
          }

          // If has closure variables, should have Closure section
          if (scopeData.closure.length > 0) {
            const hasClosureSection = lines.some(line =>
              line.includes('Closure Scope')
            );
            assert.ok(hasClosureSection, 'Should have Closure Scope section');
          }

          // If has global variables, should have Global section
          if (scopeData.global.length > 0) {
            const hasGlobalSection = lines.some(line =>
              line.includes('Global Scope')
            );
            assert.ok(hasGlobalSection, 'Should have Global Scope section');
          }

          return true;
        }),
        {numRuns: 100}
      );
    });

    it('hasScopeVariables correctly identifies non-empty scope data', () => {
      fc.assert(
        fc.property(scopeDataArb, (scopeData) => {
          const result = hasScopeVariables(scopeData);

          const hasAnyVariables =
            scopeData.local.length > 0 ||
            scopeData.closure.length > 0 ||
            scopeData.global.length > 0;

          assert.strictEqual(
            result,
            hasAnyVariables,
            'hasScopeVariables should match actual variable presence'
          );

          return true;
        }),
        {numRuns: 100}
      );
    });

    it('formatScopeSection uses correct emoji for each scope type', () => {
      const scopeTypes = ['Local', 'Closure', 'Global'];
      const expectedEmojis: Record<string, string> = {
        Local: '📍',
        Closure: '🔗',
        Global: '🌐',
      };

      fc.assert(
        fc.property(
          fc.constantFrom(...scopeTypes),
          fc.array(scopeVariableArb, {minLength: 1, maxLength: 5}),
          (scopeType, variables) => {
            const lines = formatScopeSection(scopeType, variables);

            // Should have content
            assert.ok(lines.length > 0, 'Should have content');

            // First line should have correct emoji
            const expectedEmoji = expectedEmojis[scopeType];
            assert.ok(
              lines[0].includes(expectedEmoji),
              `Should have ${expectedEmoji} emoji for ${scopeType} scope`
            );

            // Should have scope name
            assert.ok(
              lines[0].includes(`${scopeType} Scope`),
              `Should have ${scopeType} Scope in header`
            );

            return true;
          }
        ),
        {numRuns: 100}
      );
    });

    it('all formatting functions use consistent 3-space indentation', () => {
      fc.assert(
        fc.property(
          scopeDataArb,
          transformResultArb,
          (scopeData, transformResult) => {
            // Check scope formatting
            const scopeLines = formatAllScopes(scopeData, {indent: '   '});
            for (const line of scopeLines) {
              // Non-header lines should start with 3 spaces
              if (!line.includes('**') && line.trim().length > 0) {
                assert.ok(
                  line.startsWith('   '),
                  `Scope line should start with 3 spaces: "${line}"`
                );
              }
            }

            // Check transform formatting
            const transformLines = formatTransformSection(transformResult, '   ');
            for (const line of transformLines) {
              // Non-empty lines should start with 3 spaces
              if (line.trim().length > 0) {
                assert.ok(
                  line.startsWith('   '),
                  `Transform line should start with 3 spaces: "${line}"`
                );
              }
            }

            return true;
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

describe('VM State Output Unit Tests', () => {
  describe('formatHexDecimal', () => {
    it('formats zero correctly', () => {
      const result = formatHexDecimal(0);
      assert.ok(result.includes('0x0000'), 'Should format zero as 0x0000');
      assert.ok(result.includes('(0)'), 'Should include decimal 0');
    });

    it('formats max 16-bit value correctly', () => {
      const result = formatHexDecimal(65535);
      assert.ok(result.includes('0xffff'), 'Should format 65535 as 0xffff');
      assert.ok(result.includes('(65535)'), 'Should include decimal 65535');
    });

    it('handles NaN gracefully', () => {
      const result = formatHexDecimal(NaN);
      assert.strictEqual(result, 'N/A', 'Should return N/A for NaN');
    });

    it('handles Infinity gracefully', () => {
      const result = formatHexDecimal(Infinity);
      assert.strictEqual(result, 'N/A', 'Should return N/A for Infinity');
    });
  });

  describe('formatValue', () => {
    it('formats undefined correctly', () => {
      assert.strictEqual(formatValue(undefined), 'undefined');
    });

    it('formats null correctly', () => {
      assert.strictEqual(formatValue(null), 'null');
    });

    it('formats strings with quotes', () => {
      const result = formatValue('hello');
      assert.ok(result.includes('"hello"'), 'Should quote strings');
    });

    it('formats numbers without quotes', () => {
      const result = formatValue(42);
      assert.strictEqual(result, '42', 'Should not quote numbers');
    });

    it('formats arrays with length', () => {
      const result = formatValue([1, 2, 3]);
      assert.ok(result.includes('Array(3)'), 'Should show array length');
    });

    it('formats objects with preview', () => {
      const result = formatValue({a: 1, b: 2});
      assert.ok(result.includes('a:'), 'Should show object properties');
    });

    it('truncates long strings', () => {
      const longString = 'a'.repeat(200);
      const result = formatValue(longString, 50);
      assert.ok(result.length < 60, 'Should truncate long strings');
      assert.ok(result.includes('...'), 'Should include ellipsis');
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
    it('returns correct type for primitives', () => {
      assert.strictEqual(getTypeName(null), 'null');
      assert.strictEqual(getTypeName(undefined), 'undefined');
      assert.strictEqual(getTypeName(42), 'number');
      assert.strictEqual(getTypeName('hello'), 'string');
      assert.strictEqual(getTypeName(true), 'boolean');
    });

    it('returns array for arrays', () => {
      assert.strictEqual(getTypeName([1, 2, 3]), 'array');
    });

    it('returns object for plain objects', () => {
      assert.strictEqual(getTypeName({a: 1}), 'Object');
    });
  });

  describe('formatCallStackSection', () => {
    it('shows no frames message when empty', () => {
      const emptyStack: VirtualCallStack = {
        frames: [],
        totalJsFrames: 0,
        jsvmpFrameCount: 0,
        errors: [],
      };

      const lines = formatCallStackSection(emptyStack);
      const hasNoFrames = lines.some(line =>
        line.includes('No JSVMP frames detected')
      );
      assert.ok(hasNoFrames, 'Should show no frames message');
    });

    it('shows error messages when present', () => {
      const errorStack: VirtualCallStack = {
        frames: [],
        totalJsFrames: 5,
        jsvmpFrameCount: 0,
        errors: ['Test error message'],
      };

      const lines = formatCallStackSection(errorStack);
      const hasError = lines.some(line =>
        line.includes('Test error message')
      );
      assert.ok(hasError, 'Should show error message');
    });

    it('shows frame details when frames exist', () => {
      const stackWithFrames: VirtualCallStack = {
        frames: [
          {
            jsFrameIndex: 0,
            cdpCallFrameId: 'frame-1',
            virtualIp: 0x1234,
            rawIp: 0x0234,
            offset: 0x1000,
            vmasmLine: 42,
            opcodeName: 'PUSH',
          },
        ],
        totalJsFrames: 5,
        jsvmpFrameCount: 1,
        errors: [],
      };

      const lines = formatCallStackSection(stackWithFrames);

      // Should show depth
      const hasDepth = lines.some(line => line.includes('Depth: 1'));
      assert.ok(hasDepth, 'Should show depth');

      // Should show frame with hex address
      const hasHexAddress = lines.some(line => line.includes('0x1234'));
      assert.ok(hasHexAddress, 'Should show hex address');

      // Should show opcode
      const hasOpcode = lines.some(line => line.includes('PUSH'));
      assert.ok(hasOpcode, 'Should show opcode');
    });
  });

  describe('formatAllScopes', () => {
    it('returns empty array for empty scope data', () => {
      const emptyScopes: ScopeData = {
        local: [],
        closure: [],
        global: [],
      };

      const lines = formatAllScopes(emptyScopes);
      assert.strictEqual(lines.length, 0, 'Should return empty array');
    });

    it('formats local scope with correct emoji', () => {
      const scopeData: ScopeData = {
        local: [{name: 'x', value: '42', type: 'number', expandable: false}],
        closure: [],
        global: [],
      };

      const lines = formatAllScopes(scopeData);
      const hasLocalEmoji = lines.some(line => line.includes('📍'));
      assert.ok(hasLocalEmoji, 'Should have local scope emoji');
    });

    it('formats closure scope with correct emoji', () => {
      const scopeData: ScopeData = {
        local: [],
        closure: [{name: 'y', value: '"hello"', type: 'string', expandable: false}],
        global: [],
      };

      const lines = formatAllScopes(scopeData);
      const hasClosureEmoji = lines.some(line => line.includes('🔗'));
      assert.ok(hasClosureEmoji, 'Should have closure scope emoji');
    });

    it('formats global scope with correct emoji', () => {
      const scopeData: ScopeData = {
        local: [],
        closure: [],
        global: [{name: 'window', value: 'Object', type: 'object', expandable: true}],
      };

      const lines = formatAllScopes(scopeData);
      const hasGlobalEmoji = lines.some(line => line.includes('🌐'));
      assert.ok(hasGlobalEmoji, 'Should have global scope emoji');
    });

    it('shows expandable indicator for expandable values', () => {
      const scopeData: ScopeData = {
        local: [{name: 'arr', value: 'Array(3)', type: 'array', expandable: true}],
        closure: [],
        global: [],
      };

      const lines = formatAllScopes(scopeData);
      const hasExpandable = lines.some(line => line.includes('[+]'));
      assert.ok(hasExpandable, 'Should show expandable indicator');
    });
  });
});
