/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Property-based tests for bytecode context provider.
 *
 * Feature: vmasm-debug-enhancement
 * Property 8: Bytecode Context Display
 * Validates: Requirements 6.1, 6.2, 6.3
 *
 * For any paused debugger state with a valid current address, the output
 * SHALL display surrounding bytecode instructions (default 5 before and
 * 5 after) with the current instruction clearly marked.
 */

import {describe, it, beforeEach, afterEach} from 'node:test';
import * as assert from 'node:assert';
import fc from 'fast-check';
import {
  VmasmContext,
  type BytecodeContext,
  type ContextInstruction,
} from '../src/utils/vmasm-context.js';
import type {ConstantEntry} from '../src/utils/vmasm-visitor.js';

// ==========================================
// Generators for property-based testing
// ==========================================

/**
 * Generate a valid opcode name (uppercase letters and underscores)
 */
const opcodeNameArb = fc.stringMatching(/^[A-Z][A-Z_]{0,10}$/);

/**
 * Generate a valid operand (K[n], V[n], hex address, number, or identifier)
 */
const operandArb = fc.oneof(
  fc.integer({min: 0, max: 100}).map(i => `K[${i}]`),
  fc.integer({min: 0, max: 100}).map(i => `V[${i}]`),
  fc.integer({min: 0, max: 65535}).map(n => `0x${n.toString(16).padStart(4, '0')}`),
  fc.integer({min: -1000, max: 1000}).map(String),
  fc.stringMatching(/^[a-z][a-zA-Z0-9_]{0,5}$/)
);

/**
 * Generate an array of operands
 */
const operandsArb = fc.array(operandArb, {minLength: 0, maxLength: 3});

/**
 * Generate a constant entry
 */
const constantEntryArb = (index: number): fc.Arbitrary<ConstantEntry> =>
  fc.oneof(
    fc.string({minLength: 0, maxLength: 30}).map(value => ({
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
const constantsArb = fc.integer({min: 0, max: 20}).chain(count =>
  fc.tuple(...Array.from({length: count}, (_, i) => constantEntryArb(i)))
);

/**
 * Generate a vmasm instruction line
 */
const instructionLineArb = (addr: number, lineNumber: number) =>
  fc.tuple(opcodeNameArb, operandsArb).map(([opcode, operands]) => {
    const addrHex = `0x${addr.toString(16).padStart(4, '0')}`;
    const operandsStr = operands.length > 0 ? ' ' + operands.join(' ') : '';
    return `${addrHex} ${opcode}${operandsStr}`;
  });

/**
 * Generate a complete vmasm content string with instructions
 */
const vmasmContentArb = fc
  .tuple(
    fc.integer({min: 5, max: 30}), // number of instructions
    constantsArb
  )
  .chain(([numInstructions, constants]) => {
    // Generate instruction lines
    const instructionArbs = Array.from({length: numInstructions}, (_, i) =>
      instructionLineArb(i, i + 10) // addresses 0, 1, 2, ... and lines 10, 11, 12, ...
    );

    return fc.tuple(fc.tuple(...instructionArbs), fc.constant(constants));
  })
  .map(([instructions, constants]) => {
    const lines: string[] = [
      '@format jsvmp_v1',
      '@reg ip=a, sp=p, stack=v, bc=o, const=Z, storage=l',
      '',
      '@section constants',
    ];

    // Add constants
    for (const constant of constants) {
      let valueStr: string;
      switch (constant.type) {
        case 'String':
          valueStr = `String("${constant.value}")`;
          break;
        case 'Number':
          valueStr = `Number(${constant.value})`;
          break;
        case 'Boolean':
          valueStr = `Boolean(${constant.value})`;
          break;
        case 'Null':
          valueStr = 'Null';
          break;
        default:
          valueStr = String(constant.value);
      }
      lines.push(`@const K[${constant.index}] = ${valueStr}`);
    }

    lines.push('');
    lines.push('@section code');
    lines.push('@entry 0x0000');
    lines.push('');

    // Add instructions
    for (const instr of instructions) {
      lines.push(instr);
    }

    return {
      content: lines.join('\n'),
      numInstructions: instructions.length,
      constants,
    };
  });

// ==========================================
// Property Tests
// ==========================================

describe('Bytecode Context Property Tests', () => {
  let vmasmContext: VmasmContext;

  beforeEach(() => {
    vmasmContext = new VmasmContext();
  });

  afterEach(() => {
    vmasmContext.reset();
  });

  /**
   * Property 8: Bytecode Context Display
   * For any paused debugger state with a valid current address, the output
   * SHALL display surrounding bytecode instructions (default 5 before and
   * 5 after) with the current instruction clearly marked.
   *
   * Validates: Requirements 6.1, 6.2, 6.3
   */
  describe('Property 8: Bytecode Context Display', () => {
    it('context includes current instruction marked with isCurrent=true', () => {
      fc.assert(
        fc.property(vmasmContentArb, ({content, numInstructions}) => {
          const loadResult = vmasmContext.loadContent(content, 'test.vmasm');
          if (!loadResult.success) {
            // Skip invalid vmasm content
            return true;
          }

          // Pick a random valid address
          const validAddresses = vmasmContext.getValidAddresses();
          if (validAddresses.length === 0) {
            return true;
          }

          const randomIndex = Math.floor(Math.random() * validAddresses.length);
          const currentAddress = validAddresses[randomIndex];

          const context = vmasmContext.getBytecodeContext(currentAddress, 5);

          // Context should exist
          assert.ok(context, 'Context should be returned for valid address');

          // Exactly one instruction should be marked as current
          const currentInstructions = context.instructions.filter(
            i => i.isCurrent
          );
          assert.strictEqual(
            currentInstructions.length,
            1,
            'Exactly one instruction should be marked as current'
          );

          // The current instruction should have the correct address
          assert.strictEqual(
            currentInstructions[0].address,
            currentAddress,
            'Current instruction should have the correct address'
          );

          return true;
        }),
        {numRuns: 100}
      );
    });

    it('context shows up to contextLines instructions before and after', () => {
      fc.assert(
        fc.property(
          vmasmContentArb,
          fc.integer({min: 1, max: 10}),
          ({content, numInstructions}, contextLines) => {
            const loadResult = vmasmContext.loadContent(content, 'test.vmasm');
            if (!loadResult.success) {
              return true;
            }

            const validAddresses = vmasmContext.getValidAddresses();
            if (validAddresses.length === 0) {
              return true;
            }

            // Pick an address in the middle to test both before and after
            const middleIndex = Math.floor(validAddresses.length / 2);
            const currentAddress = validAddresses[middleIndex];

            const context = vmasmContext.getBytecodeContext(
              currentAddress,
              contextLines
            );

            assert.ok(context, 'Context should be returned');

            // Calculate expected range
            const expectedBefore = Math.min(middleIndex, contextLines);
            const expectedAfter = Math.min(
              validAddresses.length - 1 - middleIndex,
              contextLines
            );
            const expectedTotal = expectedBefore + 1 + expectedAfter;

            assert.strictEqual(
              context.instructions.length,
              expectedTotal,
              `Should have ${expectedTotal} instructions (${expectedBefore} before + 1 current + ${expectedAfter} after)`
            );

            return true;
          }
        ),
        {numRuns: 100}
      );
    });

    it('all instructions have valid address, opcode, and line number', () => {
      fc.assert(
        fc.property(vmasmContentArb, ({content}) => {
          const loadResult = vmasmContext.loadContent(content, 'test.vmasm');
          if (!loadResult.success) {
            return true;
          }

          const validAddresses = vmasmContext.getValidAddresses();
          if (validAddresses.length === 0) {
            return true;
          }

          const currentAddress = validAddresses[0];
          const context = vmasmContext.getBytecodeContext(currentAddress, 5);

          assert.ok(context, 'Context should be returned');

          for (const instr of context.instructions) {
            // Address should be a non-negative number
            assert.ok(
              typeof instr.address === 'number' && instr.address >= 0,
              `Address should be non-negative number: ${instr.address}`
            );

            // Address hex should be properly formatted
            assert.ok(
              /^0x[0-9a-f]{4}$/i.test(instr.addressHex),
              `Address hex should be formatted as 0xNNNN: ${instr.addressHex}`
            );

            // Opcode should be a non-empty string
            assert.ok(
              typeof instr.opcode === 'string' && instr.opcode.length > 0,
              `Opcode should be non-empty string: ${instr.opcode}`
            );

            // Line number should be positive
            assert.ok(
              typeof instr.vmasmLine === 'number' && instr.vmasmLine > 0,
              `Line number should be positive: ${instr.vmasmLine}`
            );

            // Operands should be an array
            assert.ok(
              Array.isArray(instr.operands),
              'Operands should be an array'
            );
            assert.ok(
              Array.isArray(instr.rawOperands),
              'Raw operands should be an array'
            );
          }

          return true;
        }),
        {numRuns: 100}
      );
    });

    it('instructions are ordered by address', () => {
      fc.assert(
        fc.property(vmasmContentArb, ({content}) => {
          const loadResult = vmasmContext.loadContent(content, 'test.vmasm');
          if (!loadResult.success) {
            return true;
          }

          const validAddresses = vmasmContext.getValidAddresses();
          if (validAddresses.length === 0) {
            return true;
          }

          const middleIndex = Math.floor(validAddresses.length / 2);
          const currentAddress = validAddresses[middleIndex];
          const context = vmasmContext.getBytecodeContext(currentAddress, 5);

          assert.ok(context, 'Context should be returned');

          // Check that addresses are in ascending order
          for (let i = 1; i < context.instructions.length; i++) {
            assert.ok(
              context.instructions[i].address >
                context.instructions[i - 1].address,
              'Instructions should be ordered by address'
            );
          }

          return true;
        }),
        {numRuns: 100}
      );
    });

    it('currentIndex correctly identifies the current instruction position', () => {
      fc.assert(
        fc.property(vmasmContentArb, ({content}) => {
          const loadResult = vmasmContext.loadContent(content, 'test.vmasm');
          if (!loadResult.success) {
            return true;
          }

          const validAddresses = vmasmContext.getValidAddresses();
          if (validAddresses.length === 0) {
            return true;
          }

          const randomIndex = Math.floor(Math.random() * validAddresses.length);
          const currentAddress = validAddresses[randomIndex];
          const context = vmasmContext.getBytecodeContext(currentAddress, 5);

          assert.ok(context, 'Context should be returned');

          // currentIndex should point to the instruction with isCurrent=true
          assert.ok(
            context.currentIndex >= 0 &&
              context.currentIndex < context.instructions.length,
            'currentIndex should be within bounds'
          );

          assert.strictEqual(
            context.instructions[context.currentIndex].isCurrent,
            true,
            'Instruction at currentIndex should be marked as current'
          );

          assert.strictEqual(
            context.instructions[context.currentIndex].address,
            currentAddress,
            'Instruction at currentIndex should have the current address'
          );

          return true;
        }),
        {numRuns: 100}
      );
    });

    it('formatted display includes marker for current instruction', () => {
      fc.assert(
        fc.property(vmasmContentArb, ({content}) => {
          const loadResult = vmasmContext.loadContent(content, 'test.vmasm');
          if (!loadResult.success) {
            return true;
          }

          const validAddresses = vmasmContext.getValidAddresses();
          if (validAddresses.length === 0) {
            return true;
          }

          const currentAddress = validAddresses[0];
          const context = vmasmContext.getBytecodeContext(currentAddress, 5);

          assert.ok(context, 'Context should be returned');

          const displayLines = vmasmContext.formatBytecodeContextDisplay(context);

          // Should have same number of lines as instructions
          assert.strictEqual(
            displayLines.length,
            context.instructions.length,
            'Display should have one line per instruction'
          );

          // Exactly one line should have the >>> marker
          const markedLines = displayLines.filter(line => line.includes('>>>'));
          assert.strictEqual(
            markedLines.length,
            1,
            'Exactly one line should have >>> marker'
          );

          // The marked line should be at currentIndex
          assert.ok(
            displayLines[context.currentIndex].includes('>>>'),
            'Line at currentIndex should have >>> marker'
          );

          return true;
        }),
        {numRuns: 100}
      );
    });

    it('returns undefined for invalid address', () => {
      fc.assert(
        fc.property(vmasmContentArb, ({content, numInstructions}) => {
          const loadResult = vmasmContext.loadContent(content, 'test.vmasm');
          if (!loadResult.success) {
            return true;
          }

          // Use an address that doesn't exist (beyond the instruction range)
          const invalidAddress = numInstructions + 1000;
          const context = vmasmContext.getBytecodeContext(invalidAddress, 5);

          assert.strictEqual(
            context,
            undefined,
            'Should return undefined for invalid address'
          );

          return true;
        }),
        {numRuns: 100}
      );
    });
  });
});

// ==========================================
// Unit Tests for Edge Cases
// ==========================================

describe('Bytecode Context Unit Tests', () => {
  let vmasmContext: VmasmContext;

  const sampleVmasm = `
@format v1.1
@reg ip=a, sp=p, stack=v, bc=o, const=Z, storage=l

@section constants
@const K[0] = String("hello")
@const K[1] = Number(42)
@const K[2] = Boolean(true)

@section code
@entry 0x0000

0x0000: PUSH K[0]
0x0001: PUSH K[1]
0x0002: ADD
0x0003: STORE v0
0x0004: LOAD v0
0x0005: CALL 2
0x0006: RET
0x0007: NOP
0x0008: JMP 0x0000
0x0009: END
`.trim();

  beforeEach(() => {
    vmasmContext = new VmasmContext();
    const result = vmasmContext.loadContent(sampleVmasm, 'test.vmasm');
    // Verify the vmasm loaded successfully
    if (!result.success) {
      throw new Error(`Failed to load sample vmasm: ${result.error}`);
    }
  });

  afterEach(() => {
    vmasmContext.reset();
  });

  describe('getBytecodeContext', () => {
    it('returns context for first instruction', () => {
      const context = vmasmContext.getBytecodeContext(0, 5);

      assert.ok(context, 'Context should be returned');
      assert.strictEqual(context.currentIndex, 0, 'Current should be first');
      assert.strictEqual(
        context.instructions[0].isCurrent,
        true,
        'First instruction should be current'
      );
      assert.strictEqual(context.startAddress, 0, 'Start address should be 0');
    });

    it('returns context for last instruction', () => {
      const context = vmasmContext.getBytecodeContext(9, 5);

      assert.ok(context, 'Context should be returned');
      assert.strictEqual(
        context.instructions[context.currentIndex].address,
        9,
        'Current should be at address 9'
      );
      assert.strictEqual(context.endAddress, 9, 'End address should be 9');
    });

    it('returns context for middle instruction', () => {
      const context = vmasmContext.getBytecodeContext(5, 3);

      assert.ok(context, 'Context should be returned');

      // Should have 3 before + 1 current + 3 after = 7 instructions
      assert.strictEqual(
        context.instructions.length,
        7,
        'Should have 7 instructions'
      );

      // Current should be in the middle
      assert.strictEqual(context.currentIndex, 3, 'Current should be at index 3');
    });

    it('handles context size larger than available instructions', () => {
      const context = vmasmContext.getBytecodeContext(5, 20);

      assert.ok(context, 'Context should be returned');

      // Should include all 10 instructions
      assert.strictEqual(
        context.instructions.length,
        10,
        'Should include all instructions'
      );
    });

    it('returns undefined when no vmasm loaded', () => {
      const emptyContext = new VmasmContext();
      const context = emptyContext.getBytecodeContext(0, 5);

      assert.strictEqual(context, undefined, 'Should return undefined');
    });
  });

  describe('formatContextInstruction', () => {
    it('resolves K[n] references in operands', () => {
      const context = vmasmContext.getBytecodeContext(0, 1);

      assert.ok(context, 'Context should be returned');

      const firstInstr = context.instructions[0];
      // K[0] should be resolved to show the value
      assert.ok(
        firstInstr.operands[0].includes('K[0]='),
        'K[0] should be resolved with value'
      );
      assert.ok(
        firstInstr.operands[0].includes('hello'),
        'Should show the string value'
      );
    });

    it('preserves raw operands', () => {
      const context = vmasmContext.getBytecodeContext(0, 1);

      assert.ok(context, 'Context should be returned');

      const firstInstr = context.instructions[0];
      assert.deepStrictEqual(
        firstInstr.rawOperands,
        ['K[0]'],
        'Raw operands should be preserved'
      );
    });
  });

  describe('formatBytecodeContextDisplay', () => {
    it('formats instructions with address, opcode, and line number', () => {
      const context = vmasmContext.getBytecodeContext(2, 2);

      assert.ok(context, 'Context should be returned');

      const lines = vmasmContext.formatBytecodeContextDisplay(context);

      // Check format of each line
      for (const line of lines) {
        // Should contain address in hex format
        assert.ok(/0x[0-9a-f]{4}/i.test(line), 'Should contain hex address');

        // Should contain line number
        assert.ok(/line \d+/.test(line), 'Should contain line number');
      }
    });

    it('marks current instruction with >>>', () => {
      const context = vmasmContext.getBytecodeContext(2, 2);

      assert.ok(context, 'Context should be returned');

      const lines = vmasmContext.formatBytecodeContextDisplay(context);

      // Find the line with >>>
      const currentLine = lines.find(line => line.includes('>>>'));
      assert.ok(currentLine, 'Should have a line with >>> marker');

      // Should contain the current address
      assert.ok(currentLine.includes('0x0002'), 'Should contain current address');
    });

    it('non-current instructions have spaces instead of >>>', () => {
      const context = vmasmContext.getBytecodeContext(2, 2);

      assert.ok(context, 'Context should be returned');

      const lines = vmasmContext.formatBytecodeContextDisplay(context);

      // Lines without >>> should start with spaces
      const nonCurrentLines = lines.filter(line => !line.includes('>>>'));
      for (const line of nonCurrentLines) {
        assert.ok(
          line.startsWith('   '),
          'Non-current lines should start with spaces'
        );
      }
    });
  });
});
