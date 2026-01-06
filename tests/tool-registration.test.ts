/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Property-based tests for tool registration completeness.
 * 
 * Feature: rc-devtools-rebuild
 * Property 1: 工具注册完整性
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

import {describe, it} from 'node:test';
import * as assert from 'node:assert';
import * as fc from 'fast-check';
import {tools} from '../src/tools/index.js';

// Expected tools based on requirements
const EXPECTED_TOOLS = {
  // Input tools (Requirement 3.1)
  input: ['click', 'fill', 'press_key'],
  
  // Navigation tools (Requirement 3.2)
  // Note: close_page and clear_cookies were removed per vmasm-debugger-tools requirements
  navigation: [
    'navigate_page', 'new_page',
    'list_pages', 'select_page'
  ],
  
  // Network tools (Requirement 3.3)
  network: [
    'list_network_requests', 'get_network_request', 
    'save_network_request', 
    'save_static_resource'
  ],
  
  // Debugging tools (Requirement 3.4)
  // Note: search_functions was in the design but not implemented
  // Note: step_into, step_out, analyze_call_graph, save_script_source were removed per vmasm-debugger-tools requirements
  // XHR breakpoint tools are additional debugging capabilities
  debugging: [
    'set_breakpoint', 'remove_breakpoint', 'list_breakpoints',
    'clear_all_breakpoints', 'step_over',
    'resume_execution', 'get_debugger_status', 'evaluate_script',
    'evaluate_on_call_frame', 'get_scope_variables', 'save_scope_variables',
    'get_possible_breakpoints',
    'disable_debugger',
    'set_xhr_breakpoint', 'remove_xhr_breakpoint', 'list_xhr_breakpoints'
  ],
  
  // Console tools (Requirement 3.5)
  console: ['list_console_messages', 'get_console_message'],
  
  // Screenshot/Snapshot tools (Requirement 3.6)
  screenshot: ['take_screenshot', 'take_snapshot'],
  
  // VMASM debugging tools (vmasm-debugger-tools Requirements 3.1-3.6, 4.1-4.6, 8.1-8.8)
  vmasm: [
    'load_vmasm',
    'get_vm_state',
    'set_vmasm_breakpoint',
    'list_vmasm_breakpoints',
    'remove_vmasm_breakpoint',
    'clear_vmasm_breakpoints'
  ],
};

// Flatten all expected tool names
const ALL_EXPECTED_TOOLS = Object.values(EXPECTED_TOOLS).flat();

describe('Tool Registration Completeness', () => {
  /**
   * Property 1: 工具注册完整性
   * For any expected tool name from the requirements list,
   * the tool should be registered and findable by name.
   * 
   * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
   */
  it('Property 1: All expected tools are registered', () => {
    const registeredToolNames = tools.map(t => t.name);
    
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_EXPECTED_TOOLS),
        (expectedToolName) => {
          const isRegistered = registeredToolNames.includes(expectedToolName);
          return isRegistered;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('All input tools are registered (Requirement 3.1)', () => {
    const registeredToolNames = tools.map(t => t.name);
    for (const toolName of EXPECTED_TOOLS.input) {
      assert.ok(
        registeredToolNames.includes(toolName),
        `Input tool "${toolName}" should be registered`
      );
    }
  });

  it('All navigation tools are registered (Requirement 3.2)', () => {
    const registeredToolNames = tools.map(t => t.name);
    for (const toolName of EXPECTED_TOOLS.navigation) {
      assert.ok(
        registeredToolNames.includes(toolName),
        `Navigation tool "${toolName}" should be registered`
      );
    }
  });

  it('All network tools are registered (Requirement 3.3)', () => {
    const registeredToolNames = tools.map(t => t.name);
    for (const toolName of EXPECTED_TOOLS.network) {
      assert.ok(
        registeredToolNames.includes(toolName),
        `Network tool "${toolName}" should be registered`
      );
    }
  });

  it('All debugging tools are registered (Requirement 3.4)', () => {
    const registeredToolNames = tools.map(t => t.name);
    for (const toolName of EXPECTED_TOOLS.debugging) {
      assert.ok(
        registeredToolNames.includes(toolName),
        `Debugging tool "${toolName}" should be registered`
      );
    }
  });

  it('All console tools are registered (Requirement 3.5)', () => {
    const registeredToolNames = tools.map(t => t.name);
    for (const toolName of EXPECTED_TOOLS.console) {
      assert.ok(
        registeredToolNames.includes(toolName),
        `Console tool "${toolName}" should be registered`
      );
    }
  });

  it('All screenshot/snapshot tools are registered (Requirement 3.6)', () => {
    const registeredToolNames = tools.map(t => t.name);
    for (const toolName of EXPECTED_TOOLS.screenshot) {
      assert.ok(
        registeredToolNames.includes(toolName),
        `Screenshot/Snapshot tool "${toolName}" should be registered`
      );
    }
  });

  it('All vmasm debugging tools are registered (vmasm-debugger-tools Requirements)', () => {
    const registeredToolNames = tools.map(t => t.name);
    for (const toolName of EXPECTED_TOOLS.vmasm) {
      assert.ok(
        registeredToolNames.includes(toolName),
        `VMASM tool "${toolName}" should be registered`
      );
    }
  });
});
