/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Property-based tests for scope fetcher.
 *
 * Feature: vmasm-debug-enhancement
 * Property 3: Complex Value Preview
 * Validates: Requirements 1.3, 2.6, 4.3
 *
 * For any array or object value in registers, transforms, or scopes,
 * the output SHALL show a preview with length/size information and
 * indicate expandability.
 */

import {describe, it} from 'node:test';
import * as assert from 'node:assert';
import fc from 'fast-check';
import {
  formatScopeVariable,
  formatScopeSection,
  formatAllScopes,
  hasScopeVariables,
  type ScopeVariable,
  type ScopeData,
  MAX_VARIABLES_PER_SCOPE,
} from '../src/utils/scope-fetcher.js';

// ==========================================
// Generators for property-based testing
// ==========================================

/**
 * Generate a valid variable name
 */
const variableNameArb = fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,20}$/);

/**
 * Generate a primitive value string
 */
const primitiveValueArb = fc.oneof(
  fc.string({minLength: 0, maxLength: 50}).map(s => JSON.stringify(s)),
  fc.integer().map(String),
  fc.constant('true'),
  fc.constant('false'),
  fc.constant('null'),
  fc.constant('undefined')
);

/**
 * Generate an array preview value string
 */
const arrayValueArb = fc.integer({min: 0, max: 1000}).map(length => {
  if (length === 0) return 'Array(0) []';
  const preview = Array.from({length: Math.min(length, 5)}, (_, i) => i).join(', ');
  const suffix = length > 5 ? ', ...' : '';
  return `Array(${length}) [${preview}${suffix}]`;
});

/**
 * Generate an object preview value string
 */
const objectValueArb = fc.record({
  propCount: fc.integer({min: 0, max: 20}),
  className: fc.option(fc.stringMatching(/^[A-Z][a-zA-Z]{0,10}$/), {nil: undefined}),
}).map(({propCount, className}) => {
  if (propCount === 0) {
    return className ? `${className} {}` : '{}';
  }
  const props = Array.from({length: Math.min(propCount, 3)}, (_, i) => `prop${i}: ${i}`).join(', ');
  const suffix = propCount > 3 ? ', ...' : '';
  const prefix = className ? `${className} ` : '';
  return `${prefix}{${props}${suffix}}`;
});

/**
 * Generate a scope variable type
 */
const typeArb = fc.oneof(
  fc.constant('string'),
  fc.constant('number'),
  fc.constant('boolean'),
  fc.constant('null'),
  fc.constant('undefined'),
  fc.constant('array'),
  fc.constant('object'),
  fc.constant('function'),
  fc.constant('Date'),
  fc.constant('Map'),
  fc.constant('Set')
);

/**
 * Generate a scope variable
 */
const scopeVariableArb: fc.Arbitrary<ScopeVariable> = fc.record({
  name: variableNameArb,
  value: fc.oneof(primitiveValueArb, arrayValueArb, objectValueArb),
  type: typeArb,
  expandable: fc.boolean(),
});

/**
 * Generate scope data
 */
const scopeDataArb: fc.Arbitrary<ScopeData> = fc.record({
  local: fc.array(scopeVariableArb, {minLength: 0, maxLength: 10}),
  closure: fc.array(scopeVariableArb, {minLength: 0, maxLength: 10}),
  global: fc.array(scopeVariableArb, {minLength: 0, maxLength: 10}),
});

// ==========================================
// Property Tests
// ==========================================

describe('Scope Fetcher Property Tests', () => {
  /**
   * Property 3: Complex Value Preview
   * For any array or object value in registers, transforms, or scopes,
   * the output SHALL show a preview with length/size information and
   * indicate expandability.
   *
   * Validates: Requirements 1.3, 2.6, 4.3
   */
  describe('Property 3: Complex Value Preview', () => {
    it('formatted variables contain name and value', () => {
      fc.assert(
        fc.property(scopeVariableArb, variable => {
          const formatted = formatScopeVariable(variable);

          // Should contain the variable name
          assert.ok(
            formatted.includes(variable.name),
            `Formatted output should contain variable name: ${variable.name}`
          );

          // Should contain at least part of the value (may be truncated)
          const valueStart = variable.value.substring(0, 20);
          assert.ok(
            formatted.includes(valueStart) || formatted.includes('...'),
            `Formatted output should contain value or truncation indicator`
          );
        }),
        {numRuns: 100}
      );
    });

    it('expandable variables have [+] indicator', () => {
      fc.assert(
        fc.property(
          scopeVariableArb.filter(v => v.expandable),
          variable => {
            const formatted = formatScopeVariable(variable);

            // Expandable variables should have [+] indicator
            assert.ok(
              formatted.includes('[+]'),
              `Expandable variable should have [+] indicator: ${formatted}`
            );
          }
        ),
        {numRuns: 100}
      );
    });

    it('non-expandable variables do not have [+] indicator', () => {
      fc.assert(
        fc.property(
          scopeVariableArb.filter(v => !v.expandable),
          variable => {
            const formatted = formatScopeVariable(variable);

            // Non-expandable variables should NOT have [+] indicator
            assert.ok(
              !formatted.includes('[+]'),
              `Non-expandable variable should not have [+] indicator: ${formatted}`
            );
          }
        ),
        {numRuns: 100}
      );
    });

    it('array values show length information', () => {
      fc.assert(
        fc.property(
          fc.integer({min: 0, max: 1000}),
          length => {
            const variable: ScopeVariable = {
              name: 'arr',
              value: `Array(${length}) [...]`,
              type: 'array',
              expandable: length > 0,
            };

            const formatted = formatScopeVariable(variable);

            // Should contain Array(n) format
            assert.ok(
              formatted.includes(`Array(${length})`),
              `Array value should show length: ${formatted}`
            );
          }
        ),
        {numRuns: 100}
      );
    });

    it('complex types show type information', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant('array'),
            fc.constant('object'),
            fc.constant('Date'),
            fc.constant('Map'),
            fc.constant('Set')
          ),
          type => {
            const variable: ScopeVariable = {
              name: 'complex',
              value: type === 'array' ? 'Array(5) [1, 2, ...]' : '{a: 1, ...}',
              type,
              expandable: true,
            };

            const formatted = formatScopeVariable(variable, {showType: true});

            // Should contain type information for complex types
            assert.ok(
              formatted.includes(`(${type})`),
              `Complex type should show type info: ${formatted}`
            );
          }
        ),
        {numRuns: 100}
      );
    });

    it('primitive types do not show type information by default', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant('string'),
            fc.constant('number'),
            fc.constant('boolean'),
            fc.constant('null'),
            fc.constant('undefined')
          ),
          type => {
            const variable: ScopeVariable = {
              name: 'prim',
              value: type === 'string' ? '"hello"' : type === 'number' ? '42' : type,
              type,
              expandable: false,
            };

            const formatted = formatScopeVariable(variable, {showType: true});

            // Should NOT contain type information for primitive types
            assert.ok(
              !formatted.includes(`(${type})`),
              `Primitive type should not show type info: ${formatted}`
            );
          }
        ),
        {numRuns: 100}
      );
    });

    it('scope sections include all variables', () => {
      fc.assert(
        fc.property(
          fc.array(scopeVariableArb, {minLength: 1, maxLength: 10}),
          variables => {
            const lines = formatScopeSection('Local', variables);
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

    it('empty scopes return empty array', () => {
      fc.assert(
        fc.property(
          fc.constant([] as ScopeVariable[]),
          variables => {
            const lines = formatScopeSection('Local', variables);

            // Empty scope should return empty array
            assert.strictEqual(
              lines.length,
              0,
              'Empty scope should return empty array'
            );
          }
        ),
        {numRuns: 10}
      );
    });

    it('formatAllScopes includes all non-empty scopes', () => {
      fc.assert(
        fc.property(
          scopeDataArb.filter(sd => 
            sd.local.length > 0 || sd.closure.length > 0 || sd.global.length > 0
          ),
          scopeData => {
            const lines = formatAllScopes(scopeData);
            const output = lines.join('\n');

            // Check that non-empty scopes are included
            if (scopeData.local.length > 0) {
              assert.ok(
                output.includes('Local'),
                'Output should include Local scope'
              );
            }
            if (scopeData.closure.length > 0) {
              assert.ok(
                output.includes('Closure'),
                'Output should include Closure scope'
              );
            }
            if (scopeData.global.length > 0) {
              assert.ok(
                output.includes('Global'),
                'Output should include Global scope'
              );
            }
          }
        ),
        {numRuns: 100}
      );
    });

    it('hasScopeVariables returns true when any scope has variables', () => {
      fc.assert(
        fc.property(
          scopeDataArb,
          scopeData => {
            const hasVars = hasScopeVariables(scopeData);
            const expectedHasVars = 
              scopeData.local.length > 0 ||
              scopeData.closure.length > 0 ||
              scopeData.global.length > 0;

            assert.strictEqual(
              hasVars,
              expectedHasVars,
              `hasScopeVariables should return ${expectedHasVars}`
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

describe('Scope Fetcher Unit Tests', () => {
  describe('formatScopeVariable', () => {
    it('formats simple string variable', () => {
      const variable: ScopeVariable = {
        name: 'message',
        value: '"hello world"',
        type: 'string',
        expandable: false,
      };

      const formatted = formatScopeVariable(variable);
      assert.ok(formatted.includes('message'));
      assert.ok(formatted.includes('"hello world"'));
      assert.ok(!formatted.includes('[+]'));
    });

    it('formats expandable array with indicator', () => {
      const variable: ScopeVariable = {
        name: 'items',
        value: 'Array(10) [1, 2, 3, ...]',
        type: 'array',
        expandable: true,
      };

      const formatted = formatScopeVariable(variable);
      assert.ok(formatted.includes('items'));
      assert.ok(formatted.includes('Array(10)'));
      assert.ok(formatted.includes('[+]'));
      assert.ok(formatted.includes('(array)'));
    });

    it('truncates long values', () => {
      const longValue = 'x'.repeat(200);
      const variable: ScopeVariable = {
        name: 'long',
        value: longValue,
        type: 'string',
        expandable: false,
      };

      const formatted = formatScopeVariable(variable, {maxValueLength: 50});
      assert.ok(formatted.includes('...'));
      assert.ok(formatted.length < longValue.length + 50);
    });

    it('uses custom indentation', () => {
      const variable: ScopeVariable = {
        name: 'x',
        value: '42',
        type: 'number',
        expandable: false,
      };

      const formatted = formatScopeVariable(variable, {indent: '      '});
      assert.ok(formatted.startsWith('      '));
    });
  });

  describe('formatScopeSection', () => {
    it('includes emoji header for Local scope', () => {
      const variables: ScopeVariable[] = [
        {name: 'x', value: '1', type: 'number', expandable: false},
      ];

      const lines = formatScopeSection('Local', variables);
      assert.ok(lines[0].includes('📍'));
      assert.ok(lines[0].includes('Local'));
    });

    it('includes emoji header for Closure scope', () => {
      const variables: ScopeVariable[] = [
        {name: 'x', value: '1', type: 'number', expandable: false},
      ];

      const lines = formatScopeSection('Closure', variables);
      assert.ok(lines[0].includes('🔗'));
      assert.ok(lines[0].includes('Closure'));
    });

    it('includes emoji header for Global scope', () => {
      const variables: ScopeVariable[] = [
        {name: 'x', value: '1', type: 'number', expandable: false},
      ];

      const lines = formatScopeSection('Global', variables);
      assert.ok(lines[0].includes('🌐'));
      assert.ok(lines[0].includes('Global'));
    });
  });

  describe('formatAllScopes', () => {
    it('returns empty array for empty scope data', () => {
      const scopeData: ScopeData = {
        local: [],
        closure: [],
        global: [],
      };

      const lines = formatAllScopes(scopeData);
      assert.strictEqual(lines.length, 0);
    });

    it('formats all scopes with separators', () => {
      const scopeData: ScopeData = {
        local: [{name: 'a', value: '1', type: 'number', expandable: false}],
        closure: [{name: 'b', value: '2', type: 'number', expandable: false}],
        global: [{name: 'c', value: '3', type: 'number', expandable: false}],
      };

      const lines = formatAllScopes(scopeData);
      const output = lines.join('\n');

      assert.ok(output.includes('Local'));
      assert.ok(output.includes('Closure'));
      assert.ok(output.includes('Global'));
      assert.ok(output.includes('a'));
      assert.ok(output.includes('b'));
      assert.ok(output.includes('c'));
    });
  });

  describe('hasScopeVariables', () => {
    it('returns false for empty scope data', () => {
      const scopeData: ScopeData = {
        local: [],
        closure: [],
        global: [],
      };

      assert.strictEqual(hasScopeVariables(scopeData), false);
    });

    it('returns true when only local has variables', () => {
      const scopeData: ScopeData = {
        local: [{name: 'x', value: '1', type: 'number', expandable: false}],
        closure: [],
        global: [],
      };

      assert.strictEqual(hasScopeVariables(scopeData), true);
    });
  });

  describe('MAX_VARIABLES_PER_SCOPE', () => {
    it('is set to 50', () => {
      assert.strictEqual(MAX_VARIABLES_PER_SCOPE, 50);
    });
  });
});
