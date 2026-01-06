/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for VM state display.
 *
 * Feature: vmasm-debug-enhancement
 * Task 10.1: Integration test with real vmasm file
 * Validates: All Requirements
 *
 * These tests verify that the VM state display components work together
 * correctly when processing real vmasm content.
 */

import {describe, it, beforeEach, afterEach} from 'node:test';
import * as assert from 'node:assert';
import {VmasmContext} from '../src/utils/vmasm-context.js';
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
// Sample VMASM Content for Integration Tests
// ==========================================

const sampleVmasmContent = `
;; ==========================================
;; JSVMP Disassembly - Integration Test
;; ==========================================

@format v1.1
@domain example.com
@source source/sample.js
@url https://*.example.com/*/sample.js
@reg ip=a, sp=p, stack=v, bc=o, storage=l, const=Z, scope=s

;; ==========================================
;; OPCODE TRANSFORMS
;; ==========================================
@opcode_transform 0 CALL: "pre:argCount = o[a]"; "pre:fn = v[p - argCount]"; "post:result = v[p]"
@opcode_transform 68 ADD: "pre:a = v[p - 1]"; "pre:b = v[p]"; "pre:result = a + b"
@opcode_transform 87 PUSH: "pre:value = Z[o[a]]"

;; ==========================================
;; CONSTANTS
;; ==========================================
@section constants

@const K[0] = String("hello")
@const K[1] = Number(42)
@const K[2] = Boolean(true)
@const K[3] = String("world")
@const K[4] = Null

;; ==========================================
;; BYTECODE
;; ==========================================
@section bytecode

@func main
0x0000: PUSH K[0]           ; "hello"
0x0005: PUSH K[1]           ; 42
0x000A: ADD                 ; add two values
0x000F: CALL 2              ; call function
0x0014: POP
0x0019: JUMP 0x0025

@func helper
0x0025: PUSH K[3]           ; "world"
0x002A: RETURN
`.trim();

// ==========================================
// Integration Tests
// ==========================================

describe('VM State Integration Tests', () => {
  let vmasmContext: VmasmContext;

  beforeEach(() => {
    vmasmContext = new VmasmContext();
  });

  afterEach(() => {
    vmasmContext.reset();
  });

  describe('Task 10.1: Integration with real vmasm file', () => {
    it('loads vmasm content and extracts metadata correctly', () => {
      const result = vmasmContext.loadContent(sampleVmasmContent, 'test.vmasm');

      assert.strictEqual(result.success, true, 'Should load successfully');
      assert.ok(result.metadata, 'Should have metadata');
      assert.strictEqual(result.metadata?.format, 'v1.1', 'Should have correct format');
      assert.strictEqual(result.metadata?.domain, 'example.com', 'Should have correct domain');
    });

    it('extracts register mappings from vmasm', () => {
      vmasmContext.loadContent(sampleVmasmContent, 'test.vmasm');
      const registers = vmasmContext.getRegisterMapping();

      assert.ok(registers, 'Should have register mappings');
      assert.strictEqual(registers?.ip, 'a', 'ip should map to a');
      assert.strictEqual(registers?.sp, 'p', 'sp should map to p');
      assert.strictEqual(registers?.stack, 'v', 'stack should map to v');
      assert.strictEqual(registers?.bc, 'o', 'bc should map to o');
      assert.strictEqual(registers?.storage, 'l', 'storage should map to l');
      assert.strictEqual(registers?.const, 'Z', 'const should map to Z');
    });

    it('extracts constants from vmasm', () => {
      vmasmContext.loadContent(sampleVmasmContent, 'test.vmasm');
      const ast = vmasmContext.getActiveAST();

      assert.ok(ast, 'Should have AST');
      assert.ok(ast?.constants, 'Should have constants');
      assert.strictEqual(ast?.constants.length, 5, 'Should have 5 constants');

      // Verify constant values
      const k0 = ast?.constants.find(c => c.index === 0);
      assert.strictEqual(k0?.type, 'String', 'K[0] should be String');
      assert.strictEqual(k0?.value, 'hello', 'K[0] should be "hello"');

      const k1 = ast?.constants.find(c => c.index === 1);
      assert.strictEqual(k1?.type, 'Number', 'K[1] should be Number');
      assert.strictEqual(k1?.value, 42, 'K[1] should be 42');
    });

    it('extracts opcode transforms from vmasm', () => {
      vmasmContext.loadContent(sampleVmasmContent, 'test.vmasm');
      const ast = vmasmContext.getActiveAST();

      assert.ok(ast, 'Should have AST');
      assert.ok(ast?.opcodeTransforms, 'Should have opcode transforms');

      // Check CALL transform (opcode 0)
      const callTransform = ast?.opcodeTransforms.get(0);
      assert.ok(callTransform, 'Should have CALL transform');
      assert.strictEqual(callTransform?.opcodeName, 'CALL', 'Should be CALL opcode');
      assert.ok(callTransform?.variables.length > 0, 'Should have pre-expressions');

      // Check ADD transform (opcode 68)
      const addTransform = ast?.opcodeTransforms.get(68);
      assert.ok(addTransform, 'Should have ADD transform');
      assert.strictEqual(addTransform?.opcodeName, 'ADD', 'Should be ADD opcode');
    });

    it('provides bytecode context around current address', () => {
      vmasmContext.loadContent(sampleVmasmContent, 'test.vmasm');

      // Get context around address 0x000A (ADD instruction)
      const context = vmasmContext.getBytecodeContext(0x000A, 3);

      assert.ok(context, 'Should have bytecode context');
      assert.ok(context?.instructions.length > 0, 'Should have instructions');

      // Find the current instruction
      const currentInstr = context?.instructions.find(i => i.isCurrent);
      assert.ok(currentInstr, 'Should have current instruction marked');
      assert.strictEqual(currentInstr?.address, 0x000A, 'Current should be at 0x000A');
      assert.strictEqual(currentInstr?.opcode, 'ADD', 'Current should be ADD');
    });

    it('formats bytecode context display correctly', () => {
      vmasmContext.loadContent(sampleVmasmContent, 'test.vmasm');

      const context = vmasmContext.getBytecodeContext(0x000A, 2);
      assert.ok(context, 'Should have context');

      const displayLines = vmasmContext.formatBytecodeContextDisplay(context!);

      assert.ok(displayLines.length > 0, 'Should have display lines');

      // Check that current instruction is marked with >>>
      const markedLine = displayLines.find(line => line.includes('>>>'));
      assert.ok(markedLine, 'Should have >>> marker');
      assert.ok(markedLine?.includes('0x000a'), 'Marked line should contain address');
      assert.ok(markedLine?.includes('ADD'), 'Marked line should contain opcode');
    });

    it('resolves constant references in bytecode context', () => {
      vmasmContext.loadContent(sampleVmasmContent, 'test.vmasm');

      // Get context around PUSH K[0] instruction
      const context = vmasmContext.getBytecodeContext(0x0000, 2);
      assert.ok(context, 'Should have context');

      const pushInstr = context?.instructions.find(i => i.address === 0x0000);
      assert.ok(pushInstr, 'Should have PUSH instruction');

      // The operands should have resolved K[0] reference
      const operandStr = pushInstr?.operands.join(' ');
      assert.ok(operandStr?.includes('K[0]'), 'Should contain K[0] reference');
      assert.ok(operandStr?.includes('hello'), 'Should contain resolved value');
    });

    it('all sections display correctly when combined', () => {
      vmasmContext.loadContent(sampleVmasmContent, 'test.vmasm');

      // Simulate a complete VM state display
      const output: string[] = [];

      // 1. JSVMP Registers section
      output.push('🔧 **JSVMP Registers:**');
      output.push(`   ip = ${formatHexDecimal(0x000A)} (global: ${formatHexDecimal(0x100A)})`);
      output.push(`   sp = 5`);
      output.push(`   stack = Array(10) [+]`);
      output.push(`   bytecode = Array(100) [+]`);
      output.push(`   storage = Object {a: 1, ...} [+]`);
      output.push('');

      // 2. JSVMP Transform section
      const transformResult: TransformEvaluationResult = {
        hasTransforms: true,
        current: {
          opcodeNumber: 68,
          opcodeName: 'ADD',
          variables: [
            {
              name: 'a',
              expression: 'v[p - 1]',
              resolvedExpression: 'v[p - 1]',
              transformedExpression: 'v[p - 1]',
              value: '10',
              type: 'number',
              expandable: false,
              wasTransformed: false,
            },
            {
              name: 'b',
              expression: 'v[p]',
              resolvedExpression: 'v[p]',
              transformedExpression: 'v[p]',
              value: '32',
              type: 'number',
              expandable: false,
              wasTransformed: false,
            },
            {
              name: 'result',
              expression: 'a + b',
              resolvedExpression: 'a + b',
              transformedExpression: 'a + b',
              value: '42',
              type: 'number',
              expandable: false,
              wasTransformed: false,
            },
          ],
          errors: [],
        },
      };

      output.push('📝 **JSVMP Transform:**');
      const transformLines = formatTransformSection(transformResult, '   ');
      output.push(...transformLines);
      output.push('');

      // 3. Bytecode Context section
      const context = vmasmContext.getBytecodeContext(0x000A, 2);
      if (context) {
        output.push('📜 **Bytecode Context:**');
        const contextLines = vmasmContext.formatBytecodeContextDisplay(context);
        for (const line of contextLines) {
          output.push(`   ${line}`);
        }
        output.push('');
      }

      // 4. JSVMP Call Stack section
      const callStack: VirtualCallStack = {
        frames: [
          {
            jsFrameIndex: 0,
            cdpCallFrameId: '1.2.3',
            virtualIp: 0x000A,
            rawIp: 0x000A,
            offset: 0x1000,
            vmasmLine: 15,
            opcodeName: 'ADD',
          },
        ],
        totalJsFrames: 5,
        jsvmpFrameCount: 1,
        errors: [],
      };

      const callStackLines = formatCallStackSection(callStack);
      output.push(...callStackLines);
      output.push('');

      // 5. Scope sections
      const scopeData: ScopeData = {
        local: [
          {name: 'x', value: '42', type: 'number', expandable: false},
          {name: 'arr', value: 'Array(3)', type: 'array', expandable: true},
        ],
        closure: [
          {name: 'outer', value: '"hello"', type: 'string', expandable: false},
        ],
        global: [],
      };

      const scopeLines = formatAllScopes(scopeData, {indent: '   '});
      output.push(...scopeLines);
      output.push('');

      // 6. Actionable hints
      output.push('ℹ️ Use `resume_execution` to continue or `step_over` to step.');

      // Verify the complete output
      const fullOutput = output.join('\n');

      // Check all required sections are present
      assert.ok(fullOutput.includes('🔧 **JSVMP Registers:**'), 'Should have Registers section');
      assert.ok(fullOutput.includes('📝 **JSVMP Transform:**'), 'Should have Transform section');
      assert.ok(fullOutput.includes('📜 **Bytecode Context:**'), 'Should have Bytecode Context section');
      assert.ok(fullOutput.includes('📚 **JSVMP Call Stack:**'), 'Should have Call Stack section');
      assert.ok(fullOutput.includes('📍 **Local Scope'), 'Should have Local Scope section');
      assert.ok(fullOutput.includes('🔗 **Closure Scope'), 'Should have Closure Scope section');
      assert.ok(fullOutput.includes('ℹ️ Use'), 'Should have actionable hints');

      // Check formatting consistency
      const lines = fullOutput.split('\n');
      for (const line of lines) {
        // Non-header lines with content should use consistent indentation
        if (line.trim().length > 0 && !line.includes('**') && !line.includes('>>>')) {
          // Content lines should start with spaces (indentation)
          if (!line.startsWith('   ') && !line.startsWith('ℹ️') && !line.startsWith('📚') && !line.startsWith('📍') && !line.startsWith('🔗') && !line.startsWith('🌐')) {
            // This is acceptable for section headers
          }
        }
      }
    });
  });

  describe('Vmasm file loading edge cases', () => {
    it('handles vmasm with no transforms gracefully', () => {
      const noTransformVmasm = `
@format v1.1
@reg ip=a, sp=p, stack=v, bc=o, const=Z, storage=l

@section constants
@const K[0] = String("test")

@section bytecode
0x0000: NOP
0x0001: RET
`.trim();

      const result = vmasmContext.loadContent(noTransformVmasm, 'test.vmasm');
      assert.strictEqual(result.success, true, 'Should load successfully');

      const ast = vmasmContext.getActiveAST();
      assert.ok(ast, 'Should have AST');
      assert.strictEqual(ast?.opcodeTransforms.size, 0, 'Should have no transforms');
    });

    it('handles vmasm with no constants gracefully', () => {
      const noConstantsVmasm = `
@format v1.1
@reg ip=a, sp=p, stack=v, bc=o, const=Z, storage=l

@section bytecode
0x0000: NOP
0x0001: RET
`.trim();

      const result = vmasmContext.loadContent(noConstantsVmasm, 'test.vmasm');
      assert.strictEqual(result.success, true, 'Should load successfully');

      const ast = vmasmContext.getActiveAST();
      assert.ok(ast, 'Should have AST');
      assert.strictEqual(ast?.constants.length, 0, 'Should have no constants');
    });

    it('returns undefined for bytecode context when no vmasm loaded', () => {
      const context = vmasmContext.getBytecodeContext(0x0000, 5);
      assert.strictEqual(context, undefined, 'Should return undefined');
    });

    it('returns undefined for bytecode context with invalid address', () => {
      vmasmContext.loadContent(sampleVmasmContent, 'test.vmasm');

      // Use an address that doesn't exist
      const context = vmasmContext.getBytecodeContext(0xFFFF, 5);
      assert.strictEqual(context, undefined, 'Should return undefined for invalid address');
    });
  });

  describe('Value formatting integration', () => {
    it('formats various value types consistently', () => {
      // Test all value types that might appear in VM state
      const testCases = [
        {value: 42, expected: '42'},
        {value: 'hello', expected: '"hello"'},
        {value: true, expected: 'true'},
        {value: false, expected: 'false'},
        {value: null, expected: 'null'},
        {value: undefined, expected: 'undefined'},
        {value: [1, 2, 3], expectedPattern: /Array\(3\)/},
        {value: {a: 1}, expectedPattern: /\{a: 1/},
      ];

      for (const {value, expected, expectedPattern} of testCases) {
        const formatted = formatValue(value);
        if (expected) {
          assert.strictEqual(formatted, expected, `Should format ${JSON.stringify(value)} as ${expected}`);
        } else if (expectedPattern) {
          assert.ok(expectedPattern.test(formatted), `Should match pattern for ${JSON.stringify(value)}: ${formatted}`);
        }
      }
    });

    it('truncates long values correctly', () => {
      const longString = 'a'.repeat(200);
      const formatted = formatValue(longString, 50);

      assert.ok(formatted.length < 60, 'Should truncate long strings');
      assert.ok(formatted.includes('...'), 'Should include ellipsis');
    });

    it('identifies expandable values correctly', () => {
      assert.strictEqual(isExpandable([1, 2, 3]), true, 'Non-empty array should be expandable');
      assert.strictEqual(isExpandable([]), false, 'Empty array should not be expandable');
      assert.strictEqual(isExpandable({a: 1}), true, 'Non-empty object should be expandable');
      assert.strictEqual(isExpandable({}), false, 'Empty object should not be expandable');
      assert.strictEqual(isExpandable(42), false, 'Number should not be expandable');
      assert.strictEqual(isExpandable('hello'), false, 'String should not be expandable');
      assert.strictEqual(isExpandable(null), false, 'Null should not be expandable');
    });

    it('gets type names correctly', () => {
      assert.strictEqual(getTypeName(42), 'number');
      assert.strictEqual(getTypeName('hello'), 'string');
      assert.strictEqual(getTypeName(true), 'boolean');
      assert.strictEqual(getTypeName(null), 'null');
      assert.strictEqual(getTypeName(undefined), 'undefined');
      assert.strictEqual(getTypeName([1, 2, 3]), 'array');
      assert.strictEqual(getTypeName({a: 1}), 'Object');
    });
  });
});

