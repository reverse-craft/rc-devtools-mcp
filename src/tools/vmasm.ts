/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * VMASM debugging tools for rc-devtools-mcp.
 * Provides vmasm file loading, breakpoint management, and VM state inspection.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {logger} from '../utils/logger.js';
import type {CDPSession, Page} from '../third-party/index.js';
import {zod} from '../third-party/index.js';
import {getCdpSession} from '../utils/cdp.js';
import {
  getVmasmContext,
  type VmasmBreakpoint,
} from '../utils/vmasm-context.js';
import {
  getDebugFileGenerator,
  type InterceptionConfig,
} from '../utils/debug-file-generator.js';
import {
  getDebuggerState,
  initializeDebuggerForPage,
} from '../utils/debugger-utils.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './tool-definition.js';

// ==========================================
// Fetch Interception for VMASM Debug Files
// ==========================================

/**
 * Track pages that have been initialized with VMASM Fetch interception.
 */
const vmasmInitializedPages = new WeakSet<Page>();

/**
 * Store interception configs per page
 */
const pageInterceptionConfigs = new WeakMap<Page, Map<string, InterceptionConfig>>();

/**
 * Get or create the interception configs map for a page.
 */
function getPageInterceptionConfigs(page: Page): Map<string, InterceptionConfig> {
  let configs = pageInterceptionConfigs.get(page);
  if (!configs) {
    configs = new Map();
    pageInterceptionConfigs.set(page, configs);
  }
  return configs;
}

/**
 * Handle Fetch.requestPaused event for vmasm debug file interception.
 */
async function handleVmasmRequestPaused(
  session: CDPSession,
  page: Page,
  event: any
): Promise<void> {
  const {requestId, request} = event;
  const url = request.url;
  const configs = getPageInterceptionConfigs(page);

  logger(`[vmasm] Fetch.requestPaused: ${url}`);

  // Find matching config by URL pattern
  let matchedConfig: InterceptionConfig | undefined;
  for (const config of configs.values()) {
    if (url.includes(config.scriptPattern) || config.scriptPattern === url) {
      matchedConfig = config;
      break;
    }
  }

  if (!matchedConfig) {
    logger(`[vmasm] No matching config, continuing request`);
    try {
      await session.send('Fetch.continueRequest', {requestId});
    } catch (error) {
      logger(`[vmasm] Failed to continue request: ${error}`);
    }
    return;
  }

  logger(`[vmasm] Matched pattern: ${matchedConfig.scriptPattern}`);
  logger(`[vmasm] Debug file: ${matchedConfig.debugFilePath}`);

  try {
    // Read the debug file content
    const debugFileContent = await fs.readFile(matchedConfig.debugFilePath, 'utf-8');
    const base64Body = Buffer.from(debugFileContent).toString('base64');

    logger(`[vmasm] Debug file size: ${debugFileContent.length} bytes`);

    await session.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [{name: 'Content-Type', value: 'application/javascript'}],
      body: base64Body,
    });

    logger(`[vmasm] ✅ Served debug file for ${url}`);
  } catch (error) {
    logger(`[vmasm] Error serving debug file: ${error}`);
    try {
      await session.send('Fetch.continueRequest', {requestId});
    } catch {
      // Ignore
    }
  }
}

/**
 * Enable Fetch interception with current vmasm configs.
 */
async function enableVmasmFetchInterception(session: CDPSession, page: Page): Promise<void> {
  const configs = getPageInterceptionConfigs(page);

  if (configs.size === 0) {
    return;
  }

  // Disable cache to ensure Fetch interception works even after page reload
  try {
    await session.send('Network.enable');
    await session.send('Network.setCacheDisabled', {cacheDisabled: true});
    logger('[vmasm] Network cache disabled');
  } catch (err) {
    logger(`[vmasm] Warning: Failed to disable cache: ${err}`);
  }

  const patterns: Array<{urlPattern: string; resourceType: 'Script'}> = [];
  for (const config of configs.values()) {
    patterns.push({
      urlPattern: `*${config.scriptPattern}*`,
      resourceType: 'Script' as const,
    });
  }

  await session.send('Fetch.enable', {patterns});
  logger(`[vmasm] Fetch enabled with ${patterns.length} URL pattern(s)`);
}

/**
 * Initialize Fetch interception for vmasm debug files.
 */
async function initializeVmasmFetchInterception(page: Page): Promise<CDPSession> {
  const session = await getCdpSession(page);

  if (vmasmInitializedPages.has(page)) {
    return session;
  }
  vmasmInitializedPages.add(page);

  // Listen for Fetch.requestPaused events
  session.on('Fetch.requestPaused', (event: any) => {
    handleVmasmRequestPaused(session, page, event);
  });

  // Get main frame ID
  let mainFrameId: string | undefined;
  try {
    const frameTree = await session.send('Page.getFrameTree');
    mainFrameId = (frameTree as any).frameTree?.frame?.id;
  } catch {
    // Ignore
  }

  // Re-enable Fetch on navigation
  session.on('Page.frameStartedLoading', async (params: any) => {
    const configs = getPageInterceptionConfigs(page);
    if (configs.size === 0) return;

    let isMainFrame = !mainFrameId || params.frameId === mainFrameId;
    if (!isMainFrame) {
      try {
        const frameTree = await session.send('Page.getFrameTree');
        const currentMainFrameId = (frameTree as any).frameTree?.frame?.id;
        if (params.frameId === currentMainFrameId) {
          isMainFrame = true;
          mainFrameId = currentMainFrameId;
        }
      } catch {
        isMainFrame = true;
      }
    }

    if (isMainFrame) {
      logger('[vmasm] Main frame loading, re-enabling Fetch interception...');
      try {
        await enableVmasmFetchInterception(session, page);
      } catch (err) {
        logger(`[vmasm] Error re-enabling Fetch: ${err}`);
      }
    }
  });

  // Enable Page domain for navigation events
  try {
    await session.send('Page.enable');
  } catch {
    // Ignore
  }

  logger('[vmasm] Fetch interception initialized');
  return session;
}


// ==========================================
// load_vmasm Tool
// Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8
// ==========================================

export const loadVmasm = defineTool({
  name: 'load_vmasm',
  description: `Load a vmasm file, generate debug script, and configure script interception automatically.

This tool:
1. Parses the vmasm file and extracts metadata
2. Generates a debug version of the source JS file with breakpoint instrumentation
3. Configures Fetch interception to serve the debug file when the original script is requested

After loading, you can:
- Set breakpoints using set_vmasm_breakpoint
- Get VM state when paused using get_vm_state
- List breakpoints using list_vmasm_breakpoints

**IMPORTANT:** Refresh the page after loading for the debug script to take effect.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    filePath: zod
      .string()
      .describe('Path to the vmasm file (absolute or relative to current working directory)'),
    sourceFilePath: zod
      .string()
      .optional()
      .describe('Path to the original JS source file (if not specified in vmasm @source directive)'),
  },
  handler: async (request, response, context) => {
    const {filePath, sourceFilePath} = request.params;
    const page = context.getSelectedPage();
    const vmasmContext = getVmasmContext();
    const debugFileGenerator = getDebugFileGenerator();

    // Step 1: Load and parse vmasm file
    response.appendResponseLine('📂 Loading vmasm file...');
    const loadResult = await vmasmContext.loadFile(filePath);

    if (!loadResult.success) {
      response.appendResponseLine(`❌ Failed to load vmasm file: ${loadResult.error}`);
      if (loadResult.parseError) {
        response.appendResponseLine('');
        response.appendResponseLine('Parse error details:');
        response.appendResponseLine(`   Type: ${loadResult.parseError.type}`);
        if (loadResult.parseError.line) {
          response.appendResponseLine(`   Line: ${loadResult.parseError.line}`);
        }
        if (loadResult.parseError.column) {
          response.appendResponseLine(`   Column: ${loadResult.parseError.column}`);
        }
      }
      return;
    }

    const metadata = loadResult.metadata;
    response.appendResponseLine('✅ Vmasm file parsed successfully');
    response.appendResponseLine('');

    // Display metadata
    response.appendResponseLine('📋 **Metadata:**');
    if (metadata.format) {
      response.appendResponseLine(`   Format: ${metadata.format}`);
    }
    if (metadata.domain) {
      response.appendResponseLine(`   Domain: ${metadata.domain}`);
    }
    if (metadata.url) {
      response.appendResponseLine(`   URL: ${metadata.url}`);
    }
    if (metadata.source) {
      response.appendResponseLine(`   Source: ${metadata.source}`);
    }
    response.appendResponseLine(`   Instructions: ${metadata.instructionCount}`);
    response.appendResponseLine(`   Constants: ${metadata.constantCount}`);
    response.appendResponseLine('');

    // Display register mappings
    response.appendResponseLine('📝 **Register Mappings:**');
    response.appendResponseLine(`   ip (instruction pointer): ${metadata.registers.ip}`);
    response.appendResponseLine(`   sp (stack pointer): ${metadata.registers.sp}`);
    response.appendResponseLine(`   stack: ${metadata.registers.stack}`);
    response.appendResponseLine(`   bc (bytecode): ${metadata.registers.bc}`);
    response.appendResponseLine(`   const: ${metadata.registers.const}`);
    if (metadata.registers.scope) {
      response.appendResponseLine(`   scope: ${metadata.registers.scope}`);
    }
    response.appendResponseLine('');

    // Step 2: Generate debug file
    const ast = vmasmContext.getActiveAST();
    if (!ast) {
      response.appendResponseLine('❌ Failed to get parsed AST');
      return;
    }

    response.appendResponseLine('🔧 Generating debug file...');
    const genResult = await debugFileGenerator.generate(
      {
        vmasmPath: loadResult.filePath,
        sourceFilePath,
      },
      ast
    );

    if (!genResult.success) {
      response.appendResponseLine(`⚠️ Debug file generation failed: ${genResult.error}`);
      response.appendResponseLine('');
      response.appendResponseLine('You can still use the vmasm file for address lookups,');
      response.appendResponseLine('but automatic breakpoint instrumentation is not available.');
      return;
    }

    response.appendResponseLine(`✅ Debug file generated: ${genResult.debugFilePath}`);
    response.appendResponseLine('');

    // Step 3: Configure script interception
    if (genResult.urlPattern && genResult.debugFilePath) {
      response.appendResponseLine('🔗 Configuring script interception...');

      const interceptionConfig: InterceptionConfig = {
        scriptPattern: genResult.urlPattern,
        debugFilePath: genResult.debugFilePath,
      };

      // Store config for this page
      const configs = getPageInterceptionConfigs(page);
      configs.set(loadResult.filePath, interceptionConfig);

      // Store in vmasm context as well
      vmasmContext.setInterceptionConfig(loadResult.filePath, {
        urlPattern: genResult.urlPattern,
        debugFilePath: genResult.debugFilePath,
        enabled: true,
      });

      // Initialize and enable Fetch interception
      const session = await initializeVmasmFetchInterception(page);
      await enableVmasmFetchInterception(session, page);

      response.appendResponseLine(`✅ Interception configured for: ${genResult.urlPattern}`);
      response.appendResponseLine('');
    } else {
      response.appendResponseLine('⚠️ No @url directive found in vmasm file.');
      response.appendResponseLine('   Script interception not configured.');
      response.appendResponseLine('');
    }

    // Summary
    response.appendResponseLine('📌 **Summary:**');
    response.appendResponseLine(`   Loaded: ${loadResult.filePath}`);
    response.appendResponseLine(`   Debug file: ${genResult.debugFilePath || 'N/A'}`);
    response.appendResponseLine(`   Interception: ${genResult.urlPattern ? 'Enabled' : 'Disabled'}`);
    response.appendResponseLine('');
    response.appendResponseLine('⚠️ **Refresh the page** for the debug script to take effect.');
    response.appendResponseLine('');
    response.appendResponseLine('Next steps:');
    response.appendResponseLine('   • Use `set_vmasm_breakpoint` to set breakpoints at bytecode addresses');
    response.appendResponseLine('   • Use `get_vm_state` to inspect VM state when paused');
    response.appendResponseLine('   • Use `list_vmasm_breakpoints` to see active breakpoints');
  },
});


// ==========================================
// get_vm_state Tool
// Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6
// ==========================================

/**
 * Format a value for display with truncation
 */
function formatVmValue(value: any, maxLength = 100): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';

  let str: string;
  if (typeof value === 'string') {
    str = JSON.stringify(value);
  } else if (typeof value === 'object') {
    try {
      str = JSON.stringify(value);
    } catch {
      str = String(value);
    }
  } else {
    str = String(value);
  }

  if (str.length > maxLength) {
    return str.substring(0, maxLength) + '...';
  }
  return str;
}

export const getVmState = defineTool({
  name: 'get_vm_state',
  description: `Get the current virtual machine state when paused at a breakpoint.

Returns:
- Virtual IP (instruction pointer) and current opcode
- Stack pointer and stack contents
- Bytecode information
- Constant pool contents
- Scope chain information

Uses register mappings from the loaded vmasm file to locate the correct variables.

**Note:** Must be paused at a breakpoint to use this tool.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    maxStackItems: zod
      .number()
      .int()
      .positive()
      .default(20)
      .optional()
      .describe('Maximum stack items to display (default: 20)'),
    maxConstants: zod
      .number()
      .int()
      .positive()
      .default(10)
      .optional()
      .describe('Maximum constants to display (default: 10)'),
  },
  handler: async (request, response, context) => {
    const {maxStackItems = 20, maxConstants = 10} = request.params;
    const page = context.getSelectedPage();
    const state = getDebuggerState(page);
    const vmasmContext = getVmasmContext();

    // Check if debugger is paused
    if (!state.isPaused) {
      response.appendResponseLine('⚠️ Debugger is not currently paused.');
      response.appendResponseLine('');
      response.appendResponseLine('To use this tool:');
      response.appendResponseLine('   1. Set a breakpoint using `set_vmasm_breakpoint`');
      response.appendResponseLine('   2. Refresh the page to trigger the breakpoint');
      response.appendResponseLine('   3. Call `get_vm_state` when paused');
      return;
    }

    // Get register mappings
    const registers = vmasmContext.getRegisterMapping();
    if (!registers) {
      response.appendResponseLine('⚠️ No vmasm file loaded.');
      response.appendResponseLine('Use `load_vmasm` to load a vmasm file first.');
      return;
    }

    const session = await getCdpSession(page);

    // Get the current call frame
    const callFrames = state.pausedCallFrames;
    if (!callFrames || callFrames.length === 0) {
      response.appendResponseLine('⚠️ No call frames available.');
      return;
    }

    const frame = callFrames[0];
    const scopeChain = frame.scopeChain;

    // Helper to evaluate expression in the current frame
    async function evaluateInFrame(expression: string): Promise<any> {
      try {
        const result = await session.send('Debugger.evaluateOnCallFrame', {
          callFrameId: frame.callFrameId,
          expression,
          returnByValue: true,
          silent: true,
        });
        return (result as any).result?.value;
      } catch {
        return undefined;
      }
    }

    response.appendResponseLine('🔍 **Virtual Machine State**');
    response.appendResponseLine('');

    // Get Virtual IP
    const virtualIP = await evaluateInFrame(registers.ip);
    const virtualIPHex = typeof virtualIP === 'number'
      ? `0x${virtualIP.toString(16).padStart(4, '0')}`
      : 'N/A';

    response.appendResponseLine('📍 **Execution Position:**');
    response.appendResponseLine(`   Virtual IP: ${virtualIPHex} (${virtualIP ?? 'N/A'})`);

    // Get current instruction from vmasm
    if (typeof virtualIP === 'number') {
      const instruction = vmasmContext.getInstructionAtAddress(virtualIP);
      if (instruction) {
        response.appendResponseLine(`   Opcode: ${instruction.opcode}`);
        if (instruction.operands.length > 0) {
          response.appendResponseLine(`   Operands: ${instruction.operands.join(', ')}`);
        }
        response.appendResponseLine(`   VMASM Line: ${instruction.lineNumber}`);
      }
    }
    response.appendResponseLine('');

    // Get Stack Pointer and Stack Contents
    const stackPointer = await evaluateInFrame(registers.sp);
    const stackContents = await evaluateInFrame(registers.stack);

    response.appendResponseLine('📚 **Stack:**');
    response.appendResponseLine(`   Stack Pointer: ${stackPointer ?? 'N/A'}`);

    if (Array.isArray(stackContents)) {
      const displayCount = Math.min(stackContents.length, maxStackItems);
      const sp = typeof stackPointer === 'number' ? stackPointer : stackContents.length - 1;

      response.appendResponseLine(`   Stack Size: ${stackContents.length}`);
      response.appendResponseLine('');

      if (displayCount > 0) {
        response.appendResponseLine('   Stack Contents (top to bottom):');
        for (let i = sp; i >= 0 && i >= sp - displayCount + 1; i--) {
          const marker = i === sp ? ' ← SP' : '';
          const value = formatVmValue(stackContents[i]);
          response.appendResponseLine(`      [${i}]: ${value}${marker}`);
        }
        if (sp > displayCount) {
          response.appendResponseLine(`      ... ${sp - displayCount + 1} more items`);
        }
      } else {
        response.appendResponseLine('   (empty)');
      }
    } else {
      response.appendResponseLine('   Stack: N/A');
    }
    response.appendResponseLine('');

    // Get Bytecode Info
    const bytecode = await evaluateInFrame(registers.bc);
    response.appendResponseLine('💾 **Bytecode:**');
    if (Array.isArray(bytecode)) {
      response.appendResponseLine(`   Length: ${bytecode.length}`);
      if (typeof virtualIP === 'number' && virtualIP < bytecode.length) {
        const currentOpcode = bytecode[virtualIP];
        response.appendResponseLine(`   Current Opcode Value: ${currentOpcode}`);
      }
    } else {
      response.appendResponseLine('   Bytecode: N/A');
    }
    response.appendResponseLine('');

    // Get Constants
    const constants = await evaluateInFrame(registers.const);
    response.appendResponseLine('📦 **Constant Pool:**');
    if (Array.isArray(constants)) {
      const displayCount = Math.min(constants.length, maxConstants);
      response.appendResponseLine(`   Size: ${constants.length}`);
      response.appendResponseLine('');
      for (let i = 0; i < displayCount; i++) {
        const value = formatVmValue(constants[i]);
        const type = typeof constants[i];
        response.appendResponseLine(`   K[${i}]: (${type}) ${value}`);
      }
      if (constants.length > displayCount) {
        response.appendResponseLine(`   ... ${constants.length - displayCount} more constants`);
      }
    } else {
      response.appendResponseLine('   Constants: N/A');
    }
    response.appendResponseLine('');

    // Get Scope Info
    if (registers.scope) {
      const scope = await evaluateInFrame(registers.scope);
      response.appendResponseLine('🔗 **Scope:**');
      if (scope !== undefined) {
        response.appendResponseLine(`   Value: ${formatVmValue(scope, 200)}`);
      } else {
        response.appendResponseLine('   Scope: N/A');
      }
      response.appendResponseLine('');
    }

    // Get call stack from injected __jsvmp_call_stack
    const callStack = await evaluateInFrame('window.__jsvmp_call_stack');
    if (Array.isArray(callStack) && callStack.length > 0) {
      response.appendResponseLine('📚 **JSVMP Call Stack:**');
      response.appendResponseLine(`   Depth: ${callStack.length}`);
      for (let i = callStack.length - 1; i >= 0 && i >= callStack.length - 5; i--) {
        const frame = callStack[i];
        const ipHex = typeof frame.ip === 'number'
          ? `0x${(frame.ip + (frame.offset || 0)).toString(16).padStart(4, '0')}`
          : 'N/A';
        response.appendResponseLine(`   [${i}]: IP=${ipHex}, SP=${frame.sp ?? 'N/A'}`);
      }
      if (callStack.length > 5) {
        response.appendResponseLine(`   ... ${callStack.length - 5} more frames`);
      }
      response.appendResponseLine('');
    }

    // Check for any errors from injection
    const jsvmpError = await evaluateInFrame('window.__jsvmp_error');
    if (jsvmpError) {
      response.appendResponseLine('⚠️ **JSVMP Error:**');
      response.appendResponseLine(`   ${formatVmValue(jsvmpError, 200)}`);
      response.appendResponseLine('');
    }

    response.appendResponseLine('ℹ️ Use `resume_execution` to continue or `step_over` to step.');
  },
});


// ==========================================
// Breakpoint Management Tools
// Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
// ==========================================

/**
 * Parse an address that can be either a number or a hex string.
 * Supports formats: 123, "123", "0x7b", "0X7B"
 */
function parseAddress(input: number | string): number | null {
  if (typeof input === 'number') {
    return Number.isInteger(input) && input >= 0 ? input : null;
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    // Check for hex format (0x or 0X prefix)
    if (/^0[xX][0-9a-fA-F]+$/.test(trimmed)) {
      const parsed = parseInt(trimmed, 16);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }
    // Check for decimal format
    if (/^\d+$/.test(trimmed)) {
      const parsed = parseInt(trimmed, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }
  }
  return null;
}

export const setVmasmBreakpoint = defineTool({
  name: 'set_vmasm_breakpoint',
  description: `Set a breakpoint at a vmasm bytecode address.

The breakpoint will trigger when the virtual machine's instruction pointer (Virtual_IP) reaches the specified address.

**Note:** Requires a vmasm file to be loaded first using \`load_vmasm\`.

The address must be a valid bytecode address from the loaded vmasm file.
Supports both hex string format (e.g., "0x0000", "0x100") and decimal (e.g., 0, 256).`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    address: zod
      .union([
        zod.number().int().nonnegative(),
        zod.string().regex(/^(0[xX][0-9a-fA-F]+|\d+)$/, 'Must be a decimal number or hex string (e.g., "0x100")'),
      ])
      .describe('Bytecode address - supports hex string (e.g., "0x0000", "0x100") or decimal number (e.g., 0, 256)'),
    condition: zod
      .string()
      .optional()
      .describe('Optional JavaScript condition expression. Breakpoint only triggers when this evaluates to true.'),
  },
  handler: async (request, response, context) => {
    const {address: addressInput, condition} = request.params;

    // Parse the address (supports both number and hex string)
    const address = parseAddress(addressInput);
    if (address === null) {
      response.appendResponseLine(`❌ Invalid address format: ${addressInput}`);
      response.appendResponseLine('');
      response.appendResponseLine('Supported formats:');
      response.appendResponseLine('   • Hex string: "0x0000", "0x100", "0xFF"');
      response.appendResponseLine('   • Decimal number: 0, 256, 255');
      return;
    }
    const page = context.getSelectedPage();
    const vmasmContext = getVmasmContext();

    // Check if vmasm file is loaded
    const ast = vmasmContext.getActiveAST();
    if (!ast) {
      response.appendResponseLine('❌ No vmasm file loaded.');
      response.appendResponseLine('Use `load_vmasm` to load a vmasm file first.');
      return;
    }

    // Set breakpoint in vmasm context
    const result = vmasmContext.setBreakpoint(address, condition);

    if ('error' in result) {
      response.appendResponseLine(`❌ Failed to set breakpoint: ${result.error}`);
      return;
    }

    const breakpoint = result as VmasmBreakpoint;
    const addressHex = `0x${address.toString(16).padStart(4, '0')}`;

    // Get instruction info at this address
    const instruction = vmasmContext.getInstructionAtAddress(address);

    // Set up the actual breakpoint using window.__breakpoints
    const session = await getCdpSession(page);

    try {
      // Initialize __breakpoints Set if not exists, then add the address
      await session.send('Runtime.evaluate', {
        expression: `
          if (!window.__breakpoints) {
            window.__breakpoints = new Set();
          }
          window.__breakpoints.add(${address});
          true;
        `,
        returnByValue: true,
      });

      response.appendResponseLine('✅ Breakpoint set successfully');
      response.appendResponseLine('');
      response.appendResponseLine(`**Breakpoint ID:** \`${breakpoint.id}\``);
      response.appendResponseLine(`**Address:** ${addressHex} (${address})`);

      if (instruction) {
        response.appendResponseLine(`**Opcode:** ${instruction.opcode}`);
        if (instruction.operands.length > 0) {
          response.appendResponseLine(`**Operands:** ${instruction.operands.join(', ')}`);
        }
        response.appendResponseLine(`**VMASM Line:** ${instruction.lineNumber}`);
      }

      if (condition) {
        response.appendResponseLine(`**Condition:** ${condition}`);
      }

      response.appendResponseLine('');
      response.appendResponseLine('ℹ️ The breakpoint will trigger when Virtual_IP reaches this address.');
      response.appendResponseLine('   Refresh the page if needed to hit the breakpoint.');
    } catch (error) {
      response.appendResponseLine(`❌ Failed to register breakpoint: ${error instanceof Error ? error.message : String(error)}`);
      // Remove from context since CDP registration failed
      vmasmContext.removeBreakpoint(breakpoint.id);
    }
  },
});

export const listVmasmBreakpoints = defineTool({
  name: 'list_vmasm_breakpoints',
  description: `List all active vmasm breakpoints for the current session.

Shows breakpoint ID, address, opcode, and any conditions.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {},
  handler: async (_request, response, _context) => {
    const vmasmContext = getVmasmContext();

    // Check if vmasm file is loaded
    const ast = vmasmContext.getActiveAST();
    if (!ast) {
      response.appendResponseLine('⚠️ No vmasm file loaded.');
      response.appendResponseLine('Use `load_vmasm` to load a vmasm file first.');
      return;
    }

    const breakpoints = vmasmContext.listBreakpoints();

    if (breakpoints.length === 0) {
      response.appendResponseLine('📋 No active vmasm breakpoints.');
      response.appendResponseLine('');
      response.appendResponseLine('Use `set_vmasm_breakpoint` to add a breakpoint.');
      return;
    }

    response.appendResponseLine(`📋 **${breakpoints.length} active breakpoint${breakpoints.length === 1 ? '' : 's'}:**`);
    response.appendResponseLine('');

    for (const bp of breakpoints) {
      const addressHex = `0x${bp.address.toString(16).padStart(4, '0')}`;
      const instruction = vmasmContext.getInstructionAtAddress(bp.address);

      response.appendResponseLine('---');
      response.appendResponseLine(`**ID:** \`${bp.id}\``);
      response.appendResponseLine(`**Address:** ${addressHex} (${bp.address})`);

      if (instruction) {
        response.appendResponseLine(`**Opcode:** ${instruction.opcode}`);
        if (instruction.operands.length > 0) {
          response.appendResponseLine(`**Operands:** ${instruction.operands.join(', ')}`);
        }
        response.appendResponseLine(`**VMASM Line:** ${instruction.lineNumber}`);
      }

      if (bp.condition) {
        response.appendResponseLine(`**Condition:** ${bp.condition}`);
      }

      response.appendResponseLine(`**Hit Count:** ${bp.hitCount}`);
    }
  },
});

export const removeVmasmBreakpoint = defineTool({
  name: 'remove_vmasm_breakpoint',
  description: `Remove a vmasm breakpoint by its ID.

Use \`list_vmasm_breakpoints\` to see active breakpoints and their IDs.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    breakpointId: zod
      .string()
      .describe('The breakpoint ID to remove (e.g., "vmasm-bp-1")'),
  },
  handler: async (request, response, context) => {
    const {breakpointId} = request.params;
    const page = context.getSelectedPage();
    const vmasmContext = getVmasmContext();

    // Get breakpoint info before removing
    const breakpoint = vmasmContext.getBreakpointById(breakpointId);
    if (!breakpoint) {
      response.appendResponseLine(`❌ Breakpoint not found: \`${breakpointId}\``);
      response.appendResponseLine('');
      response.appendResponseLine('Use `list_vmasm_breakpoints` to see active breakpoints.');
      return;
    }

    const address = breakpoint.address;

    // Remove from vmasm context
    const removed = vmasmContext.removeBreakpoint(breakpointId);
    if (!removed) {
      response.appendResponseLine(`❌ Failed to remove breakpoint: \`${breakpointId}\``);
      return;
    }

    // Remove from window.__breakpoints
    const session = await getCdpSession(page);
    try {
      await session.send('Runtime.evaluate', {
        expression: `
          if (window.__breakpoints) {
            window.__breakpoints.delete(${address});
          }
          true;
        `,
        returnByValue: true,
      });
    } catch {
      // Ignore - page might not have the breakpoints set
    }

    const addressHex = `0x${address.toString(16).padStart(4, '0')}`;
    response.appendResponseLine(`✅ Removed breakpoint \`${breakpointId}\` at ${addressHex}`);
  },
});

export const clearVmasmBreakpoints = defineTool({
  name: 'clear_vmasm_breakpoints',
  description: `Remove all vmasm breakpoints for the current session.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {},
  handler: async (_request, response, context) => {
    const page = context.getSelectedPage();
    const vmasmContext = getVmasmContext();

    const count = vmasmContext.clearBreakpoints();

    // Clear window.__breakpoints
    const session = await getCdpSession(page);
    try {
      await session.send('Runtime.evaluate', {
        expression: `
          if (window.__breakpoints) {
            window.__breakpoints.clear();
          }
          true;
        `,
        returnByValue: true,
      });
    } catch {
      // Ignore - page might not have the breakpoints set
    }

    if (count === 0) {
      response.appendResponseLine('📋 No breakpoints to clear.');
    } else {
      response.appendResponseLine(`✅ Cleared ${count} breakpoint${count === 1 ? '' : 's'}.`);
    }
  },
});
