/**
 * Test for opcode names containing digits
 * Regression test for vmasm parser issue with PUSH_UNDEF2
 */

import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {parseVmasm, isParseError} from '../src/utils/vmasm-visitor.js';

describe('Opcode names with digits', () => {
  it('parses opcode_transform with digit in opcode name (PUSH_UNDEF2)', () => {
    const content = `@format v1.5
@reg ip=a, sp=p, stack=v, bc=o, storage=l, const=Z

@opcode_transform 33 PUSH_UNDEF2: "pre:value = undefined"
@opcode_transform 34 PUSH_THIS: "pre:value = this"

@section code
@entry 0x0000
0x0000 PUSH_UNDEF2
0x0001 PUSH_THIS
`;

    const result = parseVmasm(content);
    
    if (isParseError(result)) {
      assert.fail(`Parse failed: ${result.message} at line ${result.line}`);
    }

    assert.ok(result.opcodeTransforms, 'Should have opcode transforms');
    assert.equal(result.opcodeTransforms.size, 2, 'Should have 2 transforms');
    
    const pushUndef2Transform = result.opcodeTransforms.get(33);
    assert.ok(pushUndef2Transform, 'Should find PUSH_UNDEF2 transform');
    assert.equal(pushUndef2Transform.opcodeName, 'PUSH_UNDEF2', 'Transform name should be PUSH_UNDEF2');
  });

  it('parses multiple opcodes with digits in names', () => {
    const content = `@format v1.5
@reg ip=a, sp=p, stack=v, bc=o, storage=l, const=Z

@opcode_transform 1 TEST1: "pre:value = 1"
@opcode_transform 2 TEST2ABC: "pre:value = 2"
@opcode_transform 3 TEST_3_XYZ: "pre:value = 3"
@opcode_transform 4 A1B2C3: "pre:value = 4"

@section code
@entry 0x0000
0x0000 TEST1
`;

    const result = parseVmasm(content);
    
    if (isParseError(result)) {
      assert.fail(`Parse failed: ${result.message} at line ${result.line}`);
    }

    assert.ok(result.opcodeTransforms, 'Should have opcode transforms');
    assert.equal(result.opcodeTransforms.size, 4, 'Should have 4 transforms');
    
    const names = Array.from(result.opcodeTransforms.values()).map(t => t.opcodeName);
    assert.deepEqual(names, ['TEST1', 'TEST2ABC', 'TEST_3_XYZ', 'A1B2C3'], 
      'Should parse all opcode names with digits correctly');
  });
});
