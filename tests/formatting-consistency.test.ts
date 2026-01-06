/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Property-based tests for output formatting consistency.
 *
 * Feature: vmasm-debug-enhancement
 * Property 7: Output Formatting Consistency
 * Validates: Requirements 5.1, 5.2, 5.3
 *
 * For any get_vm_state output, the formatting SHALL use consistent
 * indentation (3 spaces), emoji section headers, and truncate long
 * values (>100 chars) with "..." indicator.
 */

import {describe, it} from 'node:test';
import * as assert from 'node:assert';
import fc from 'fast-check';
import {
  formatHexDecimal,
  formatValue,
  truncateString,
  isExpandable,
  getTypeName,
} from '../src/utils/vm-state-utils.js';
import {
  formatTransformSection,
  formatEvaluatedVariable,
  type TransformEvaluationResult,
  type EvaluatedVariable,
} from '../src/utils/transform-evaluator.js';
import {
  formatCallStackSection,
  formatJsvmpFrame,
  type VirtualCallStack,
  type JsvmpFrame,
} from '../src/utils/virtual-call-stack.js';
import {
  formatAllScopes,
  formatScopeSection,
  type ScopeData,
  type ScopeVariable,
} from '../src/utils/scope-fetcher.js';

// ==========================================
// Generators for property-based testing
// ==========================================

/**
 * Generate a valid address (0-65535)
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
 * Generate a string of various lengths for truncation testing
 */
const variableLengthStringArb = fc.string({minLength: 0, maxLength: 300});

/**
 * Generate a JavaScript value for testing
 */
const jsValueArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({minLength: 0, maxLength: 150}),
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
  transformedExpression: fc.string({minLength: 1, maxLength: 30}),
  value: fc.string({minLength: 1, maxLength: 150}),
  type: fc.constantFrom('string', 'number', 'boolean', 'object', 'array', 'null', 'undefined'),
  expandable: fc.boolean(),
  error: fc.option(fc.string({minLength: 1, maxLength: 30}), {nil: undefined}),
  isPost: fc.option(fc.boolean(), {nil: undefined}),
  wasTransformed: fc.boolean(),
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
 * Generate a virtual call stack
 */
const virtualCallStackArb: fc.Arbitrary<VirtualCallStack> = fc.array(jsvmpFrameArb, {minLength: 0, maxLength: 10})
  .chain(frames => fc.record({
    frames: fc.constant(frames),
    totalJsFrames: fc.integer({min: frames.length, max: 50}),
    jsvmpFrameCount: fc.constant(frames.length),
    errors: fc.array(fc.string({minLength: 1, maxLength: 50}), {minLength: 0, maxLength: 3}),
  }));

/**
 * Generate a scope variable
 */
const scopeVariableArb: fc.Arbitrary<ScopeVariable> = fc.record({
  name: variableNameArb,
  value: fc.string({minLength: 1, maxLength: 150}),
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

describe('Output Formatting Consistency Property Tests', () => {
  /**
   * Property 7: Output Formatting Consistency
   * For any get_vm_state output, the formatting SHALL use consistent
   * indentation (3 spaces), emoji section headers, and truncate long
   * values (>100 chars) with "..." indicator.
   *
   * Validates: Requirements 5.1, 5.2, 5.3
   */
  describe('Property 7: Output Formatting Consistency', () => {
    it('truncateString always truncates strings longer than maxLength', () => {
      fc.assert(
        fc.property(
          variableLengthStringArb,
          fc.integer({min: 10, max: 200}),
          (str, maxLength) => {
            const result = truncateString(str, maxLength);

            if (str.length <= maxLength) {
              // Should not be truncated
              assert.strictEqual(result, str, 'Short strings should not be truncated');
            } else {
              // Should be truncated with ...
              assert.ok(
                result.length <= maxLength + 3,
                `Truncated string should be at most maxLength + 3: got ${result.length}, expected <= ${maxLength + 3}`
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

    it('formatValue truncates long string values', () => {
      fc.assert(
        fc.property(
          fc.string({minLength: 150, maxLength: 500}),
          fc.integer({min: 50, max: 100}),
          (str, maxLength) => {
            const result = formatValue(str, maxLength);

            // Result should be truncated (accounting for JSON quotes)
            assert.ok(
              result.length <= maxLength + 5, // +5 for quotes and ...
              `Formatted value should be truncated: got ${result.length}, expected <= ${maxLength + 5}`
            );

            // Should contain ellipsis if truncated
            if (str.length > maxLength - 2) { // -2 for quotes
              assert.ok(
                result.includes('...'),
                'Long strings should be truncated with ...'
              );
            }

            return true;
          }
        ),
        {numRuns: 100}
      );
    });

    it('formatHexDecimal produces consistent format for all addresses', () => {
      fc.assert(
        fc.property(addressArb, (address) => {
          const result = formatHexDecimal(address);

          // Should match pattern: 0xNNNN (decimal)
          const pattern = /^0x[0-9a-f]{4,} \(\d+\)$/i;
          assert.ok(
            pattern.test(result),
            `Result should match hex (decimal) format: ${result}`
          );

          // Should contain the correct decimal value
          assert.ok(
            result.includes(`(${address})`),
            `Result should contain decimal value (${address}): ${result}`
          );

          return true;
        }),
        {numRuns: 100}
      );
    });

    it('formatTransformSection uses consistent 3-space indentation', () => {
      fc.assert(
        fc.property(transformResultArb, (result) => {
          const lines = formatTransformSection(result, '   ');

          for (const line of lines) {
            // All non-empty lines should start with 3 spaces
            if (line.trim().length > 0) {
              assert.ok(
                line.startsWith('   '),
                `Transform line should start with 3 spaces: "${line}"`
              );
            }
          }

          return true;
        }),
        {numRuns: 100}
      );
    });

    it('formatAllScopes uses consistent 3-space indentation when specified', () => {
      fc.assert(
        fc.property(scopeDataArb, (scopeData) => {
          const lines = formatAllScopes(scopeData, {indent: '   '});

          for (const line of lines) {
            // Non-header lines should start with 3 spaces
            if (line.trim().length > 0 && !line.includes('**')) {
              assert.ok(
                line.startsWith('   '),
                `Scope line should start with 3 spaces: "${line}"`
              );
            }
          }

          return true;
        }),
        {numRuns: 100}
      );
    });

    it('scope sections use correct emoji headers', () => {
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
              `Should have ${expectedEmoji} emoji for ${scopeType} scope: ${lines[0]}`
            );

            return true;
          }
        ),
        {numRuns: 100}
      );
    });

    it('call stack section uses emoji header', () => {
      fc.assert(
        fc.property(virtualCallStackArb, (callStack) => {
          const lines = formatCallStackSection(callStack);

          // First line should have call stack emoji
          assert.ok(
            lines[0].includes('📚'),
            `Call stack header should have 📚 emoji: ${lines[0]}`
          );

          return true;
        }),
        {numRuns: 100}
      );
    });

    it('formatJsvmpFrame produces consistent format', () => {
      fc.assert(
        fc.property(jsvmpFrameArb, fc.integer({min: 0, max: 50}), (frame, index) => {
          const formatted = formatJsvmpFrame(frame, index);

          // Should contain frame index
          assert.ok(
            formatted.includes(`[${index}]`),
            `Should contain frame index [${index}]: ${formatted}`
          );

          // Should contain hex address
          const hexPattern = /0x[0-9a-f]{4,}/i;
          assert.ok(
            hexPattern.test(formatted),
            `Should contain hex address: ${formatted}`
          );

          // Should contain line info (either number or ?)
          assert.ok(
            formatted.includes('line'),
            `Should contain line info: ${formatted}`
          );

          return true;
        }),
        {numRuns: 100}
      );
    });

    it('formatEvaluatedVariable includes expandable indicator when appropriate', () => {
      fc.assert(
        fc.property(evaluatedVariableArb, (variable) => {
          const formatted = formatEvaluatedVariable(variable);

          if (variable.expandable) {
            assert.ok(
              formatted.includes('[+]'),
              `Expandable variable should have [+] indicator: ${formatted}`
            );
          }

          return true;
        }),
        {numRuns: 100}
      );
    });

    it('formatEvaluatedVariable includes type information for complex types', () => {
      // The implementation only shows type info for non-primitive types
      // (not for string, number, boolean, null, undefined)
      const complexTypes = ['object', 'array'];

      fc.assert(
        fc.property(
          evaluatedVariableArb.filter(v => complexTypes.includes(v.type)),
          (variable) => {
            const formatted = formatEvaluatedVariable(variable);

            // Should contain type in parentheses for complex types
            assert.ok(
              formatted.includes(`(${variable.type})`),
              `Should contain type (${variable.type}) for complex types: ${formatted}`
            );

            return true;
          }
        ),
        {numRuns: 100}
      );
    });

    it('formatEvaluatedVariable omits type for primitive types', () => {
      // The implementation omits type info for primitive types
      const primitiveTypes = ['string', 'number', 'boolean', 'null', 'undefined'];

      fc.assert(
        fc.property(
          evaluatedVariableArb.filter(v => primitiveTypes.includes(v.type)),
          (variable) => {
            const formatted = formatEvaluatedVariable(variable);

            // Should NOT contain type in parentheses for primitive types
            assert.ok(
              !formatted.includes(`(${variable.type})`),
              `Should NOT contain type (${variable.type}) for primitive types: ${formatted}`
            );

            return true;
          }
        ),
        {numRuns: 100}
      );
    });

    it('all formatting functions produce non-empty output for valid input', () => {
      fc.assert(
        fc.property(
          addressArb,
          jsValueArb,
          (address, value) => {
            // formatHexDecimal should produce non-empty output
            const hexResult = formatHexDecimal(address);
            assert.ok(hexResult.length > 0, 'formatHexDecimal should produce non-empty output');

            // formatValue should produce non-empty output
            const valueResult = formatValue(value);
            assert.ok(valueResult.length > 0, 'formatValue should produce non-empty output');

            // getTypeName should produce non-empty output
            const typeResult = getTypeName(value);
            assert.ok(typeResult.length > 0, 'getTypeName should produce non-empty output');

            return true;
          }
        ),
        {numRuns: 100}
      );
    });

    it('isExpandable returns boolean for all value types', () => {
      fc.assert(
        fc.property(jsValueArb, (value) => {
          const result = isExpandable(value);
          assert.strictEqual(typeof result, 'boolean', 'isExpandable should return boolean');
          return true;
        }),
        {numRuns: 100}
      );
    });

    it('output lines do not exceed reasonable length', () => {
      fc.assert(
        fc.property(
          transformResultArb,
          scopeDataArb,
          virtualCallStackArb,
          (transformResult, scopeData, callStack) => {
            const maxLineLength = 200; // Reasonable max line length

            // Check transform lines
            const transformLines = formatTransformSection(transformResult, '   ');
            for (const line of transformLines) {
              assert.ok(
                line.length <= maxLineLength,
                `Transform line should not exceed ${maxLineLength} chars: ${line.length}`
              );
            }

            // Check scope lines
            const scopeLines = formatAllScopes(scopeData, {indent: '   '});
            for (const line of scopeLines) {
              assert.ok(
                line.length <= maxLineLength,
                `Scope line should not exceed ${maxLineLength} chars: ${line.length}`
              );
            }

            // Check call stack lines
            const callStackLines = formatCallStackSection(callStack);
            for (const line of callStackLines) {
              assert.ok(
                line.length <= maxLineLength,
                `Call stack line should not exceed ${maxLineLength} chars: ${line.length}`
              );
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

describe('Output Formatting Consistency Unit Tests', () => {
  describe('truncateString', () => {
    it('does not truncate strings at exactly maxLength', () => {
      const str = 'a'.repeat(100);
      const result = truncateString(str, 100);
      assert.strictEqual(result, str, 'Should not truncate at exactly maxLength');
    });

    it('truncates strings one char over maxLength', () => {
      const str = 'a'.repeat(101);
      const result = truncateString(str, 100);
      assert.ok(result.endsWith('...'), 'Should truncate with ...');
      assert.strictEqual(result.length, 103, 'Should be maxLength + 3');
    });

    it('handles empty string', () => {
      const result = truncateString('', 100);
      assert.strictEqual(result, '', 'Empty string should remain empty');
    });
  });

  describe('formatHexDecimal', () => {
    it('pads small numbers to 4 hex digits', () => {
      const result = formatHexDecimal(0);
      assert.ok(result.includes('0x0000'), 'Should pad to 4 digits');
    });

    it('handles large numbers correctly', () => {
      const result = formatHexDecimal(65535);
      assert.ok(result.includes('0xffff'), 'Should format large numbers');
      assert.ok(result.includes('(65535)'), 'Should include decimal');
    });

    it('handles NaN', () => {
      const result = formatHexDecimal(NaN);
      assert.strictEqual(result, 'N/A', 'Should return N/A for NaN');
    });

    it('handles Infinity', () => {
      const result = formatHexDecimal(Infinity);
      assert.strictEqual(result, 'N/A', 'Should return N/A for Infinity');
    });

    it('handles negative Infinity', () => {
      const result = formatHexDecimal(-Infinity);
      assert.strictEqual(result, 'N/A', 'Should return N/A for -Infinity');
    });
  });

  describe('formatValue', () => {
    it('formats arrays with length info', () => {
      const result = formatValue([1, 2, 3, 4, 5]);
      assert.ok(result.includes('Array(5)'), 'Should show array length');
    });

    it('formats objects with preview', () => {
      const result = formatValue({a: 1, b: 2});
      assert.ok(result.includes('a:'), 'Should show object properties');
    });

    it('formats functions', () => {
      const result = formatValue(() => {});
      assert.strictEqual(result, '[Function]', 'Should format functions');
    });

    it('formats symbols', () => {
      const sym = Symbol('test');
      const result = formatValue(sym);
      assert.ok(result.includes('Symbol'), 'Should format symbols');
    });

    it('formats bigints', () => {
      const result = formatValue(BigInt(123));
      assert.strictEqual(result, '123n', 'Should format bigints with n suffix');
    });
  });

  describe('Emoji consistency', () => {
    it('uses correct emojis for all section types', () => {
      // Registers: 🔧
      // Transform: 📝
      // Bytecode Context: 📜
      // Call Stack: 📚
      // Local Scope: 📍
      // Closure Scope: 🔗
      // Global Scope: 🌐
      // Stack Contents: 📚
      // Constant Pool: 📦
      // Hints: ℹ️

      const localLines = formatScopeSection('Local', [{name: 'x', value: '1', type: 'number', expandable: false}]);
      assert.ok(localLines[0].includes('📍'), 'Local scope should use 📍');

      const closureLines = formatScopeSection('Closure', [{name: 'y', value: '2', type: 'number', expandable: false}]);
      assert.ok(closureLines[0].includes('🔗'), 'Closure scope should use 🔗');

      const globalLines = formatScopeSection('Global', [{name: 'z', value: '3', type: 'number', expandable: false}]);
      assert.ok(globalLines[0].includes('🌐'), 'Global scope should use 🌐');

      const callStackLines = formatCallStackSection({
        frames: [],
        totalJsFrames: 0,
        jsvmpFrameCount: 0,
        errors: [],
      });
      assert.ok(callStackLines[0].includes('📚'), 'Call stack should use 📚');
    });
  });

  describe('Indentation consistency', () => {
    it('transform section uses 3-space indentation', () => {
      const result: TransformEvaluationResult = {
        hasTransforms: true,
        current: {
          opcodeNumber: 68,
          opcodeName: 'ADD',
          variables: [
            {
              name: 'a',
              expression: 'v[p]',
              resolvedExpression: 'v[p]',
              transformedExpression: 'v[p]',
              value: '42',
              type: 'number',
              expandable: false,
              wasTransformed: false,
            },
          ],
          errors: [],
        },
      };

      const lines = formatTransformSection(result, '   ');
      for (const line of lines) {
        if (line.trim().length > 0) {
          assert.ok(line.startsWith('   '), `Line should start with 3 spaces: "${line}"`);
        }
      }
    });

    it('scope section uses 3-space indentation when specified', () => {
      const scopeData: ScopeData = {
        local: [{name: 'x', value: '42', type: 'number', expandable: false}],
        closure: [],
        global: [],
      };

      const lines = formatAllScopes(scopeData, {indent: '   '});
      for (const line of lines) {
        if (line.trim().length > 0 && !line.includes('**')) {
          assert.ok(line.startsWith('   '), `Line should start with 3 spaces: "${line}"`);
        }
      }
    });
  });
});

