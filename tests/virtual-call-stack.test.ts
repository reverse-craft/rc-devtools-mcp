/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Property-based tests for virtual call stack construction.
 *
 * Feature: vmasm-debug-enhancement
 * Property 6: Call Stack Frame Information
 * Validates: Requirements 3.2, 3.3, 3.4
 *
 * For any detected JSVMP frame in the call stack, the output SHALL include
 * virtual IP (hex and decimal), vmasm line number (if mappable), and opcode
 * name (if available), ordered from innermost to outermost.
 */

import {describe, it} from 'node:test';
import * as assert from 'node:assert';
import fc from 'fast-check';
import {
  type JsvmpFrame,
  type VirtualCallStack,
  formatJsvmpFrame,
  formatCallStackSection,
  formatCallStackOutput,
  createEmptyVirtualCallStack,
} from '../src/utils/virtual-call-stack.js';
import type {CallFrame} from '../src/utils/debugger-utils.js';

// ==========================================
// Generators for property-based testing
// ==========================================

/**
 * Generate a valid virtual IP (bytecode address)
 */
const virtualIpArb = fc.integer({min: 0, max: 65535});

/**
 * Generate a valid raw IP
 */
const rawIpArb = fc.integer({min: 0, max: 65535});

/**
 * Generate a valid offset
 */
const offsetArb = fc.integer({min: 0, max: 65535});

/**
 * Generate a valid stack pointer
 */
const spArb = fc.option(fc.integer({min: 0, max: 1000}), {nil: undefined});

/**
 * Generate a valid vmasm line number
 */
const vmasmLineArb = fc.option(fc.integer({min: 1, max: 10000}), {nil: undefined});

/**
 * Generate a valid opcode name
 */
const opcodeNameArb = fc.option(
  fc.stringMatching(/^[A-Z][A-Z_]{0,15}$/),
  {nil: undefined}
);

/**
 * Generate a valid function name
 */
const functionNameArb = fc.option(
  fc.oneof(
    fc.constant('(anonymous)'),
    fc.stringMatching(/^[a-z][a-zA-Z0-9_]{0,20}$/)
  ),
  {nil: undefined}
);

/**
 * Generate a valid CDP call frame ID
 */
const callFrameIdArb = fc.stringMatching(/^[0-9]+\.[0-9]+\.[0-9]+$/);

/**
 * Generate a JSVMP frame
 */
const jsvmpFrameArb: fc.Arbitrary<JsvmpFrame> = fc.record({
  jsFrameIndex: fc.integer({min: 0, max: 50}),
  cdpCallFrameId: callFrameIdArb,
  virtualIp: virtualIpArb,
  rawIp: rawIpArb,
  offset: offsetArb,
  sp: spArb,
  vmasmLine: vmasmLineArb,
  opcodeName: opcodeNameArb,
  functionName: functionNameArb,
});

/**
 * Generate a virtual call stack
 */
const virtualCallStackArb: fc.Arbitrary<VirtualCallStack> = fc.record({
  frames: fc.array(jsvmpFrameArb, {minLength: 0, maxLength: 10}),
  totalJsFrames: fc.integer({min: 0, max: 100}),
  jsvmpFrameCount: fc.integer({min: 0, max: 50}),
  errors: fc.array(fc.string({minLength: 1, maxLength: 100}), {minLength: 0, maxLength: 5}),
}).map(stack => ({
  ...stack,
  jsvmpFrameCount: stack.frames.length, // Ensure consistency
}));

/**
 * Generate a JavaScript call frame (for fallback display)
 */
const jsCallFrameArb: fc.Arbitrary<CallFrame> = fc.record({
  callFrameId: callFrameIdArb,
  functionName: fc.oneof(
    fc.constant(''),
    fc.constant('(anonymous)'),
    fc.stringMatching(/^[a-z][a-zA-Z0-9_]{0,20}$/)
  ),
  location: fc.record({
    scriptId: fc.stringMatching(/^[0-9]+$/),
    lineNumber: fc.integer({min: 0, max: 10000}),
    columnNumber: fc.option(fc.integer({min: 0, max: 1000}), {nil: undefined}),
  }),
  url: fc.oneof(
    fc.constant(''),
    fc.webUrl()
  ),
  scopeChain: fc.constant([]), // Simplified for testing
});

// ==========================================
// Property Tests
// ==========================================

describe('Virtual Call Stack Property Tests', () => {
  /**
   * Property 6: Call Stack Frame Information
   * For any detected JSVMP frame in the call stack, the output SHALL include
   * virtual IP (hex and decimal), vmasm line number (if mappable), and opcode
   * name (if available), ordered from innermost to outermost.
   *
   * Validates: Requirements 3.2, 3.3, 3.4
   */
  describe('Property 6: Call Stack Frame Information', () => {
    it('formatted frame contains virtual IP in hexadecimal format', () => {
      fc.assert(
        fc.property(jsvmpFrameArb, fc.integer({min: 0, max: 50}), (frame, index) => {
          const formatted = formatJsvmpFrame(frame, index);

          // Virtual IP should be in hex format (0x followed by hex digits)
          const hexPattern = /0x[0-9a-f]{4,}/i;
          assert.ok(
            hexPattern.test(formatted),
            `Formatted frame should contain hex virtual IP: ${formatted}`
          );

          // The hex value should match the frame's virtualIp
          const expectedHex = `0x${frame.virtualIp.toString(16).padStart(4, '0')}`;
          assert.ok(
            formatted.includes(expectedHex),
            `Formatted frame should contain ${expectedHex}: ${formatted}`
          );
        }),
        {numRuns: 100}
      );
    });

    it('formatted frame contains opcode name when available', () => {
      fc.assert(
        fc.property(
          jsvmpFrameArb.filter(f => f.opcodeName !== undefined),
          fc.integer({min: 0, max: 50}),
          (frame, index) => {
            const formatted = formatJsvmpFrame(frame, index);

            assert.ok(
              formatted.includes(frame.opcodeName!),
              `Formatted frame should contain opcode name "${frame.opcodeName}": ${formatted}`
            );
          }
        ),
        {numRuns: 100}
      );
    });

    it('formatted frame shows "unknown" when opcode name is not available', () => {
      fc.assert(
        fc.property(
          jsvmpFrameArb.map(f => ({...f, opcodeName: undefined})),
          fc.integer({min: 0, max: 50}),
          (frame, index) => {
            const formatted = formatJsvmpFrame(frame, index);

            assert.ok(
              formatted.includes('unknown'),
              `Formatted frame should show "unknown" for missing opcode: ${formatted}`
            );
          }
        ),
        {numRuns: 100}
      );
    });

    it('formatted frame contains vmasm line number when available', () => {
      fc.assert(
        fc.property(
          jsvmpFrameArb.filter(f => f.vmasmLine !== undefined),
          fc.integer({min: 0, max: 50}),
          (frame, index) => {
            const formatted = formatJsvmpFrame(frame, index);

            assert.ok(
              formatted.includes(`line ${frame.vmasmLine}`),
              `Formatted frame should contain line number: ${formatted}`
            );
          }
        ),
        {numRuns: 100}
      );
    });

    it('formatted frame shows "line ?" when vmasm line is not available', () => {
      fc.assert(
        fc.property(
          jsvmpFrameArb.map(f => ({...f, vmasmLine: undefined})),
          fc.integer({min: 0, max: 50}),
          (frame, index) => {
            const formatted = formatJsvmpFrame(frame, index);

            assert.ok(
              formatted.includes('line ?'),
              `Formatted frame should show "line ?" for missing line: ${formatted}`
            );
          }
        ),
        {numRuns: 100}
      );
    });

    it('formatted frame contains frame index', () => {
      fc.assert(
        fc.property(jsvmpFrameArb, fc.integer({min: 0, max: 50}), (frame, index) => {
          const formatted = formatJsvmpFrame(frame, index);

          assert.ok(
            formatted.includes(`[${index}]`),
            `Formatted frame should contain index [${index}]: ${formatted}`
          );
        }),
        {numRuns: 100}
      );
    });

    it('call stack section displays all frames in order', () => {
      fc.assert(
        fc.property(
          virtualCallStackArb.filter(s => s.frames.length > 0),
          callStack => {
            const lines = formatCallStackSection(callStack);
            const output = lines.join('\n');

            // All frames should be present
            for (let i = 0; i < callStack.frames.length; i++) {
              const frame = callStack.frames[i];
              const expectedHex = `0x${frame.virtualIp.toString(16).padStart(4, '0')}`;

              assert.ok(
                output.includes(expectedHex),
                `Output should contain frame ${i} virtual IP ${expectedHex}`
              );

              assert.ok(
                output.includes(`[${i}]`),
                `Output should contain frame index [${i}]`
              );
            }
          }
        ),
        {numRuns: 100}
      );
    });

    it('call stack section shows "No JSVMP frames detected" when empty', () => {
      fc.assert(
        fc.property(
          virtualCallStackArb.map(s => ({...s, frames: [], jsvmpFrameCount: 0, errors: []})),
          callStack => {
            const lines = formatCallStackSection(callStack);
            const output = lines.join('\n');

            assert.ok(
              output.includes('No JSVMP frames detected'),
              `Empty call stack should show "No JSVMP frames detected": ${output}`
            );
          }
        ),
        {numRuns: 100}
      );
    });

    it('call stack section shows depth count', () => {
      fc.assert(
        fc.property(
          virtualCallStackArb.filter(s => s.frames.length > 0),
          callStack => {
            const lines = formatCallStackSection(callStack);
            const output = lines.join('\n');

            assert.ok(
              output.includes(`Depth: ${callStack.jsvmpFrameCount}`),
              `Output should show depth: ${callStack.jsvmpFrameCount}`
            );
          }
        ),
        {numRuns: 100}
      );
    });

    it('call stack section falls back to JS call stack on errors with no frames', () => {
      fc.assert(
        fc.property(
          fc.array(jsCallFrameArb, {minLength: 1, maxLength: 5}),
          fc.array(fc.string({minLength: 1, maxLength: 50}), {minLength: 1, maxLength: 3}),
          (jsFrames, errors) => {
            const callStack: VirtualCallStack = {
              frames: [],
              totalJsFrames: jsFrames.length,
              jsvmpFrameCount: 0,
              errors,
            };

            const lines = formatCallStackSection(callStack, jsFrames);
            const output = lines.join('\n');

            // Should show error message
            assert.ok(
              output.includes('Failed to construct virtual call stack'),
              `Output should show error message: ${output}`
            );

            // Should show JavaScript call stack fallback
            assert.ok(
              output.includes('JavaScript Call Stack (fallback)'),
              `Output should show JS fallback: ${output}`
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

describe('Virtual Call Stack Unit Tests', () => {
  describe('formatJsvmpFrame', () => {
    it('formats frame with all fields', () => {
      const frame: JsvmpFrame = {
        jsFrameIndex: 0,
        cdpCallFrameId: '1.2.3',
        virtualIp: 0x1234,
        rawIp: 0x0234,
        offset: 0x1000,
        sp: 5,
        vmasmLine: 42,
        opcodeName: 'PUSH',
        functionName: 'dispatcher',
      };

      const formatted = formatJsvmpFrame(frame, 0);

      assert.ok(formatted.includes('[0]'));
      assert.ok(formatted.includes('0x1234'));
      assert.ok(formatted.includes('PUSH'));
      assert.ok(formatted.includes('line 42'));
    });

    it('formats frame with minimal fields', () => {
      const frame: JsvmpFrame = {
        jsFrameIndex: 2,
        cdpCallFrameId: '4.5.6',
        virtualIp: 0x0000,
        rawIp: 0x0000,
        offset: 0x0000,
      };

      const formatted = formatJsvmpFrame(frame, 2);

      assert.ok(formatted.includes('[2]'));
      assert.ok(formatted.includes('0x0000'));
      assert.ok(formatted.includes('unknown'));
      assert.ok(formatted.includes('line ?'));
    });
  });

  describe('formatCallStackSection', () => {
    it('handles empty call stack', () => {
      const callStack = createEmptyVirtualCallStack();
      const lines = formatCallStackSection(callStack);

      assert.ok(lines.some(l => l.includes('No JSVMP frames detected')));
    });

    it('handles call stack with errors but no frames', () => {
      const callStack: VirtualCallStack = {
        frames: [],
        totalJsFrames: 5,
        jsvmpFrameCount: 0,
        errors: ['Error 1', 'Error 2'],
      };

      const jsFrames: CallFrame[] = [
        {
          callFrameId: '1.2.3',
          functionName: 'testFunc',
          location: {scriptId: '1', lineNumber: 10},
          url: 'test.js',
          scopeChain: [],
        },
      ];

      const lines = formatCallStackSection(callStack, jsFrames);
      const output = lines.join('\n');

      assert.ok(output.includes('Failed to construct'));
      assert.ok(output.includes('JavaScript Call Stack (fallback)'));
      assert.ok(output.includes('testFunc'));
    });

    it('handles call stack with multiple frames', () => {
      const callStack: VirtualCallStack = {
        frames: [
          {
            jsFrameIndex: 0,
            cdpCallFrameId: '1.2.3',
            virtualIp: 0x100,
            rawIp: 0x100,
            offset: 0,
            opcodeName: 'CALL',
            vmasmLine: 10,
          },
          {
            jsFrameIndex: 2,
            cdpCallFrameId: '4.5.6',
            virtualIp: 0x200,
            rawIp: 0x200,
            offset: 0,
            opcodeName: 'PUSH',
            vmasmLine: 20,
          },
        ],
        totalJsFrames: 5,
        jsvmpFrameCount: 2,
        errors: [],
      };

      const lines = formatCallStackSection(callStack);
      const output = lines.join('\n');

      assert.ok(output.includes('Depth: 2'));
      assert.ok(output.includes('[0]'));
      assert.ok(output.includes('[1]'));
      assert.ok(output.includes('0x0100'));
      assert.ok(output.includes('0x0200'));
      assert.ok(output.includes('CALL'));
      assert.ok(output.includes('PUSH'));
    });
  });

  describe('formatCallStackOutput', () => {
    it('returns string output', () => {
      const callStack = createEmptyVirtualCallStack();
      const output = formatCallStackOutput(callStack);

      assert.strictEqual(typeof output, 'string');
      assert.ok(output.length > 0);
    });
  });

  describe('createEmptyVirtualCallStack', () => {
    it('creates empty call stack with correct structure', () => {
      const callStack = createEmptyVirtualCallStack();

      assert.deepStrictEqual(callStack.frames, []);
      assert.strictEqual(callStack.totalJsFrames, 0);
      assert.strictEqual(callStack.jsvmpFrameCount, 0);
      assert.deepStrictEqual(callStack.errors, []);
    });
  });
});
