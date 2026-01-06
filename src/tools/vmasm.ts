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
// Global Interception Configuration
// ==========================================

/**
 * Global interception config - shared across all pages
 * This is the key difference from before: we store config globally, not per-page
 */
interface GlobalInterceptionConfig {
  scriptPattern: string;
  debugFilePath: string;
}

let globalInterceptionConfig: GlobalInterceptionConfig | null = null;

/**
 * Set global interception config
 */
export function setGlobalInterceptionConfig(config: GlobalInterceptionConfig | null): void {
  globalInterceptionConfig = config;
  logger(`[vmasm] Global interception config ${config ? 'SET' : 'CLEARED'}`);
  if (config) {
    logger(`[vmasm]   scriptPattern: ${config.scriptPattern}`);
    logger(`[vmasm]   debugFilePath: ${config.debugFilePath}`);
  }
}

/**
 * Get global interception config
 */
export function getGlobalInterceptionConfig(): GlobalInterceptionConfig | null {
  return globalInterceptionConfig;
}

// ==========================================
// Fetch Interception for VMASM Debug Files
// ==========================================

/**
 * Track pages that have been initialized with VMASM Fetch interception.
 * Uses WeakSet to avoid memory leaks when pages are closed.
 */
const vmasmInitializedPages = new WeakSet<Page>();

/**
 * Track pages that have Fetch.requestPaused handler registered.
 * This prevents duplicate handler registration.
 */
const fetchHandlerRegistered = new WeakSet<Page>();

/**
 * Track injected breakpoint script identifiers per page.
 * Used to remove old scripts before injecting new ones when breakpoints change.
 */
const pageBreakpointScriptIds = new WeakMap<Page, string[]>();

/**
 * Track page to CDP session mapping for breakpoint sync.
 */
const pageCdpSessions = new WeakMap<Page, CDPSession>();

/**
 * Handle Fetch.requestPaused event for vmasm debug file interception.
 */
async function handleVmasmRequestPaused(
  session: CDPSession,
  event: any
): Promise<void> {
  const {requestId, request} = event;
  const url = request.url;

  // Get global config
  const config = globalInterceptionConfig;
  if (!config) {
    logger(`[vmasm] Fetch.requestPaused: ${url} - No config, continuing`);
    try {
      await session.send('Fetch.continueRequest', {requestId});
    } catch (error) {
      logger(`[vmasm] Failed to continue request: ${error}`);
    }
    return;
  }

  // Check if URL matches the pattern (support wildcards)
  const isMatch = urlMatchesPattern(url, config.scriptPattern);

  if (!isMatch) {
    // Only log non-matching requests at debug level to reduce noise
    try {
      await session.send('Fetch.continueRequest', {requestId});
    } catch (error) {
      logger(`[vmasm] Failed to continue request: ${error}`);
    }
    return;
  }

  logger(`[vmasm] ========================================`);
  logger(`[vmasm] >>> SCRIPT INTERCEPTED <<<`);
  logger(`[vmasm]   Original URL: ${url}`);
  logger(`[vmasm]   Matched pattern: ${config.scriptPattern}`);
  logger(`[vmasm]   Debug file: ${config.debugFilePath}`);

  try {
    // Read the debug file content
    const debugFileContent = await fs.readFile(config.debugFilePath, 'utf-8');
    const base64Body = Buffer.from(debugFileContent).toString('base64');

    logger(`[vmasm]   Debug file size: ${debugFileContent.length} bytes`);

    await session.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [{name: 'Content-Type', value: 'application/javascript'}],
      body: base64Body,
    });

    logger(`[vmasm] >>> SCRIPT REPLACED SUCCESSFULLY <<<`);
    logger(`[vmasm] ========================================`);
  } catch (error) {
    logger(`[vmasm] Error serving debug file: ${error}`);
    logger(`[vmasm] ========================================`);
    try {
      await session.send('Fetch.continueRequest', {requestId});
    } catch {
      // Ignore
    }
  }
}

/**
 * Check if URL matches the pattern (supports wildcards).
 */
function urlMatchesPattern(url: string, pattern: string): boolean {
  if (!pattern) return false;
  
  // If pattern doesn't contain wildcards, use simple includes
  if (!pattern.includes('*')) {
    return url.includes(pattern);
  }
  
  // Convert wildcard pattern to regex
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')  // Escape special regex chars
    .replace(/\*/g, '.*');  // Convert * to .*
  const regex = new RegExp(escaped);
  return regex.test(url);
}

/**
 * Enable Fetch interception on a CDP session.
 * Uses global config to determine URL pattern.
 */
async function enableFetchInterception(session: CDPSession): Promise<void> {
  const config = globalInterceptionConfig;
  if (!config) {
    logger('[vmasm] No global config, skipping Fetch.enable');
    return;
  }

  // Build URL pattern with wildcards for CDP Fetch.enable
  const urlPattern = config.scriptPattern.includes('*')
    ? config.scriptPattern
    : `*${config.scriptPattern}*`;

  logger(`[vmasm] Enabling Fetch interception`);
  logger(`[vmasm]   URL pattern: ${urlPattern}`);

  try {
    await session.send('Fetch.enable', {
      patterns: [{
        resourceType: 'Script',
        urlPattern: urlPattern,
      }],
    });
    logger('[vmasm] Fetch.enable SUCCESS');
  } catch (err) {
    logger(`[vmasm] Fetch.enable FAILED: ${err}`);
  }
}

/**
 * Set up complete page interception for VMASM debugging.
 * This sets up ALL necessary CDP domains for a page.
 * 
 * Uses the shared CDP session from cdp.ts to avoid conflicts with other tools.
 */
async function setupPageInterception(page: Page): Promise<CDPSession> {
  // Check if already initialized - but still get session for return
  const session = await getCdpSession(page);
  
  // Store page to session mapping for breakpoint sync
  pageCdpSessions.set(page, session);
  
  if (vmasmInitializedPages.has(page)) {
    logger(`[vmasm] Page already initialized: ${page.url() || 'about:blank'}`);
    // Still re-enable Fetch if config exists (in case config was set after init)
    if (globalInterceptionConfig && !fetchHandlerRegistered.has(page)) {
      await registerFetchHandler(page, session);
    }
    await enableFetchInterception(session);
    return session;
  }

  logger(`[vmasm] Setting up page interception for: ${page.url() || 'about:blank'}`);
  vmasmInitializedPages.add(page);

  // Step 1: Enable Network domain and disable cache
  // This ensures Fetch interception works even after page reload
  try {
    await session.send('Network.enable');
    await session.send('Network.setCacheDisabled', {cacheDisabled: true});
    logger('[vmasm] Network.setCacheDisabled: cache DISABLED');
  } catch (err) {
    logger(`[vmasm] WARNING: Failed to disable cache: ${err}`);
  }

  // Step 2: Enable Page domain for script injection and navigation events
  try {
    await session.send('Page.enable');
    logger('[vmasm] Page.enable SUCCESS');
  } catch (err) {
    logger(`[vmasm] WARNING: Page.enable failed: ${err}`);
  }

  // Step 3: Register Fetch handler and enable Fetch interception
  await registerFetchHandler(page, session);
  await enableFetchInterception(session);

  // Step 4: Set up navigation listener to re-enable Fetch on page refresh
  await setupNavigationListener(page, session);

  // Step 5: Inject breakpoint initialization script (pass page for tracking)
  await injectBreakpointInitScript(session, page);

  logger('[vmasm] Page interception setup complete');
  return session;
}

/**
 * Register Fetch.requestPaused handler for a page.
 * Only registers once per page to avoid duplicate handlers.
 */
async function registerFetchHandler(page: Page, session: CDPSession): Promise<void> {
  if (fetchHandlerRegistered.has(page)) {
    return;
  }
  
  session.on('Fetch.requestPaused', (event: any) => {
    handleVmasmRequestPaused(session, event);
  });
  fetchHandlerRegistered.add(page);
  logger('[vmasm] Fetch.requestPaused handler registered');
}

/**
 * Set up navigation listener to re-enable Fetch on page refresh.
 */
async function setupNavigationListener(page: Page, session: CDPSession): Promise<void> {
  // Get main frame ID for navigation detection
  let mainFrameId: string | undefined;
  try {
    const frameTree = await session.send('Page.getFrameTree');
    mainFrameId = (frameTree as any).frameTree?.frame?.id;
    logger(`[vmasm] Main frame ID: ${mainFrameId}`);
  } catch {
    // Ignore
  }

  // Re-enable Fetch on navigation (critical for page refresh)
  session.on('Page.frameStartedLoading', async (params: any) => {
    // Only re-enable for main frame
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

    if (isMainFrame && globalInterceptionConfig) {
      logger('[vmasm] Main frame loading, re-enabling Fetch interception...');
      try {
        await enableFetchInterception(session);
      } catch (err) {
        logger(`[vmasm] Error re-enabling Fetch: ${err}`);
      }
    }
  });
}

/**
 * Inject breakpoint initialization script to page.
 * This ensures window.__breakpoints is available.
 */
async function injectBreakpointInitScript(session: CDPSession, page?: Page): Promise<void> {
  const vmasmContext = getVmasmContext();
  const breakpoints = vmasmContext.listBreakpoints();
  const addresses = breakpoints.map(bp => bp.address);

  const initScript = `
    // VMASM Debugger: Initialize breakpoint set
    (function() {
      if (typeof window !== 'undefined') {
        window.__jsvmp_breakpoint_addrs = ${JSON.stringify(addresses)};
        window.__breakpoints = new Set(window.__jsvmp_breakpoint_addrs);
        console.log('[VMASM] Breakpoints initialized:', window.__breakpoints.size, 'addresses');
      }
    })();
  `;

  try {
    // Add script to run on new documents
    const result = await session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: initScript,
    }) as {identifier: string};
    logger(`[vmasm] Breakpoint init script added (${addresses.length} addresses)`);

    // Track the script identifier for this page so we can remove it later
    if (page) {
      const existingIds = pageBreakpointScriptIds.get(page) || [];
      existingIds.push(result.identifier);
      pageBreakpointScriptIds.set(page, existingIds);
    }

    // Also execute immediately in current context
    try {
      await session.send('Runtime.evaluate', {
        expression: initScript,
      });
      logger('[vmasm] Breakpoint init script executed in current context');
    } catch (err) {
      logger(`[vmasm] WARNING: Failed to execute in current context: ${err}`);
    }
  } catch (error) {
    logger(`[vmasm] ERROR: Failed to inject breakpoint script: ${error}`);
  }
}

/**
 * Sync breakpoints to a specific page.
 * Removes old injected scripts and injects new ones with updated breakpoint addresses.
 * This ensures breakpoints persist across page refreshes.
 */
async function syncBreakpointsToPage(page: Page): Promise<void> {
  const session = pageCdpSessions.get(page);
  if (!session) {
    logger('[vmasm] Cannot sync breakpoints: no CDP session for page');
    return;
  }

  // Remove old injected scripts
  const oldIds = pageBreakpointScriptIds.get(page) || [];
  for (const id of oldIds) {
    try {
      await session.send('Page.removeScriptToEvaluateOnNewDocument', {identifier: id});
      logger(`[vmasm] Removed old breakpoint script: ${id}`);
    } catch (err) {
      // Script may already be removed
      logger(`[vmasm] WARNING: Failed to remove old script ${id}: ${err}`);
    }
  }
  pageBreakpointScriptIds.set(page, []);

  // Inject new script with updated breakpoints
  await injectBreakpointInitScript(session, page);
}

/**
 * Sync breakpoints to all initialized pages.
 * Called when breakpoints are added, removed, or cleared.
 */
export async function syncBreakpointsToAllPages(): Promise<void> {
  const vmasmContext = getVmasmContext();
  const breakpoints = vmasmContext.listBreakpoints();
  const addresses = breakpoints.map(bp => bp.address);
  
  logger(`[vmasm] Syncing ${addresses.length} breakpoints to all pages...`);
  
  // We need to iterate over all tracked pages
  // Since WeakMap doesn't support iteration, we need to track pages differently
  // For now, we'll sync to the current page via the context
  // This is a limitation - in a full implementation, we'd need to track pages in a Set
}

/**
 * Initialize VMASM interception for a page.
 * This is the main entry point - call this before any vmasm operations.
 * 
 * This function is safe to call multiple times - it will only set up
 * interception once per page, but will re-enable Fetch if config exists.
 */
export async function initializeVmasmForPage(page: Page): Promise<CDPSession> {
  return await setupPageInterception(page);
}

/**
 * Check if VMASM interception is configured.
 * Returns true if there's a global interception config set.
 */
export function isVmasmInterceptionConfigured(): boolean {
  return globalInterceptionConfig !== null;
}

/**
 * Initialize VMASM interception for a page if config exists.
 * This is called by mcp-context.ts when new pages are created.
 * 
 * Unlike initializeVmasmForPage, this function only sets up interception
 * if there's an active global config, avoiding unnecessary setup.
 */
export async function maybeInitializeVmasmForPage(page: Page): Promise<void> {
  if (!globalInterceptionConfig) {
    return;
  }
  
  logger(`[vmasm] Auto-initializing interception for new page: ${page.url() || 'about:blank'}`);
  await setupPageInterception(page);
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

      // Set global interception config - this is used by all pages
      setGlobalInterceptionConfig({
        scriptPattern: genResult.urlPattern,
        debugFilePath: genResult.debugFilePath,
      });

      // Store in vmasm context as well
      vmasmContext.setInterceptionConfig(loadResult.filePath, {
        urlPattern: genResult.urlPattern,
        debugFilePath: genResult.debugFilePath,
        enabled: true,
      });

      // Initialize page interception (sets up all CDP domains)
      await initializeVmasmForPage(page);

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
// Requirements: 1.1, 2.1, 3.1, 4.1, 5.1, 5.2, 5.4, 5.5, 6.1
// ==========================================

import {
  formatHexDecimal,
  formatValue,
  isExpandable,
  getTypeName,
} from '../utils/vm-state-utils.js';
import {
  evaluateTransformVariables,
  formatTransformSection,
  type TransformEvaluationResult,
} from '../utils/transform-evaluator.js';
import {
  constructVirtualCallStack,
  formatCallStackSection,
} from '../utils/virtual-call-stack.js';
import {
  fetchScopeVariables,
  formatAllScopes,
  hasScopeVariables,
} from '../utils/scope-fetcher.js';
import {
  OpcodeListingProvider,
  getFormattedOpcodeListing,
} from '../utils/opcode-listing-provider.js';
import type {OpcodeTransform} from '../utils/vmasm-visitor.js';

export const getVmState = defineTool({
  name: 'get_vm_state',
  description: `Get the current virtual machine state when paused at a breakpoint.

Returns comprehensive debugging information including:
- JSVMP Registers (ip, sp, stack, bytecode, storage)
- JSVMP Transform variables (semantic meaning of current opcode with AST-transformed expressions)
- Opcode Listing (surrounding instructions with resolved constant values)
- JSVMP Call Stack (virtual call frames)
- Scope Chain (local, closure, global variables)

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
    contextLines: zod
      .number()
      .int()
      .positive()
      .default(5)
      .optional()
      .describe('Number of bytecode instructions to show before/after current (default: 5)'),
  },
  handler: async (request, response, context) => {
    const {maxStackItems = 20, maxConstants = 10, contextLines = 5} = request.params;
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

    // ==========================================
    // Section 1: JSVMP Registers
    // Requirements: 1.1, 1.2, 1.3, 1.4, 1.5
    // ==========================================
    response.appendResponseLine('🔧 **JSVMP Registers:**');

    // Get Virtual IP and offset
    const virtualIP = await evaluateInFrame(registers.ip);
    const offset = await evaluateInFrame('__jsvmp_offset') ?? 0;
    const globalAddress = typeof virtualIP === 'number' && typeof offset === 'number'
      ? virtualIP + offset
      : undefined;

    // Format ip with raw and global values
    if (typeof virtualIP === 'number') {
      const ipDisplay = globalAddress !== undefined
        ? `${formatHexDecimal(virtualIP)} (global: ${formatHexDecimal(globalAddress)})`
        : formatHexDecimal(virtualIP);
      response.appendResponseLine(`   ip = ${ipDisplay}`);
    } else {
      response.appendResponseLine(`   ip = <unavailable>`);
    }

    // Get Stack Pointer
    const stackPointer = await evaluateInFrame(registers.sp);
    if (typeof stackPointer === 'number') {
      response.appendResponseLine(`   sp = ${stackPointer}`);
    } else {
      response.appendResponseLine(`   sp = <unavailable>`);
    }

    // Get Stack array
    const stackContents = await evaluateInFrame(registers.stack);
    if (Array.isArray(stackContents)) {
      response.appendResponseLine(`   stack = Array(${stackContents.length}) [+]`);
    } else {
      response.appendResponseLine(`   stack = <unavailable>`);
    }

    // Get Bytecode array
    const bytecode = await evaluateInFrame(registers.bc);
    if (Array.isArray(bytecode)) {
      response.appendResponseLine(`   bytecode = Array(${bytecode.length}) [+]`);
    } else {
      response.appendResponseLine(`   bytecode = <unavailable>`);
    }

    // Get Storage
    const storage = await evaluateInFrame(registers.storage);
    if (storage !== undefined) {
      const storageDisplay = formatValue(storage, 50);
      const expandable = isExpandable(storage) ? ' [+]' : '';
      response.appendResponseLine(`   storage = ${storageDisplay}${expandable}`);
    } else {
      response.appendResponseLine(`   storage = <unavailable>`);
    }

    response.appendResponseLine('');

    // ==========================================
    // Section 2: JSVMP Transform
    // Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
    // ==========================================
    const ast = vmasmContext.getActiveAST();
    const currentAddress = globalAddress ?? virtualIP;

    if (ast && typeof currentAddress === 'number' && Array.isArray(bytecode)) {
      const opcodeTransforms = ast.opcodeTransforms;
      const constants = ast.constants;

      // Get the opcode number at the current address
      const opcodeNumber = bytecode[currentAddress];
      const currentTransform = opcodeNumber !== undefined
        ? opcodeTransforms.get(opcodeNumber)
        : undefined;

      if (currentTransform && currentTransform.variables.length > 0) {
        // Evaluate transform variables
        const transformResult = await evaluateTransformVariables(
          session,
          frame.callFrameId,
          currentAddress,
          opcodeTransforms,
          constants,
          registers,
          bytecode,
          undefined // No previous transform tracking for now
        );

        if (transformResult.hasTransforms) {
          response.appendResponseLine('📝 **JSVMP Transform:**');
          const transformLines = formatTransformSection(transformResult, '   ');
          for (const line of transformLines) {
            response.appendResponseLine(line);
          }
          response.appendResponseLine('');
        }
      }
    }

    // ==========================================
    // Section 3: Opcode Listing
    // Requirements: 1.1, 5.4
    // ==========================================
    if (typeof currentAddress === 'number') {
      try {
        const opcodeListing = getFormattedOpcodeListing(vmasmContext, currentAddress, contextLines);
        if (opcodeListing && opcodeListing.length > 0) {
          response.appendResponseLine('📜 **Opcode Listing:**');
          for (const line of opcodeListing) {
            response.appendResponseLine(`   ${line}`);
          }
          response.appendResponseLine('');
        }
      } catch (error) {
        // Requirement 5.4: Handle errors gracefully (skip section on failure)
        logger(`[get_vm_state] Failed to generate opcode listing: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // ==========================================
    // Section 4: JSVMP Call Stack
    // Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
    // ==========================================
    const virtualCallStack = await constructVirtualCallStack(
      session,
      callFrames,
      vmasmContext
    );

    const callStackLines = formatCallStackSection(virtualCallStack, callFrames);
    for (const line of callStackLines) {
      response.appendResponseLine(line);
    }
    response.appendResponseLine('');

    // ==========================================
    // Section 5: Scope Chain
    // Requirements: 4.1, 4.2, 4.3, 4.4
    // ==========================================
    try {
      const scopeData = await fetchScopeVariables(session, frame.scopeChain);

      if (hasScopeVariables(scopeData)) {
        const scopeLines = formatAllScopes(scopeData, {indent: '   '});
        for (const line of scopeLines) {
          response.appendResponseLine(line);
        }
        response.appendResponseLine('');
      }
    } catch (error) {
      // Requirement 4.4: Handle unavailable scopes gracefully
      // Skip scope sections if fetching fails
    }

    // ==========================================
    // Section 6: Stack Contents (detailed)
    // ==========================================
    if (Array.isArray(stackContents) && stackContents.length > 0) {
      response.appendResponseLine('📚 **Stack Contents:**');
      const sp = typeof stackPointer === 'number' ? stackPointer : stackContents.length - 1;
      const displayCount = Math.min(stackContents.length, maxStackItems);

      for (let i = sp; i >= 0 && i >= sp - displayCount + 1; i--) {
        const marker = i === sp ? ' ← SP' : '';
        const value = formatValue(stackContents[i], 80);
        response.appendResponseLine(`   [${i}]: ${value}${marker}`);
      }
      if (sp > displayCount) {
        response.appendResponseLine(`   ... ${sp - displayCount + 1} more items`);
      }
      response.appendResponseLine('');
    }

    // ==========================================
    // Section 7: Constant Pool (summary)
    // ==========================================
    const constants = await evaluateInFrame(registers.const);
    if (Array.isArray(constants) && constants.length > 0) {
      response.appendResponseLine('📦 **Constant Pool:**');
      response.appendResponseLine(`   Size: ${constants.length}`);
      const displayCount = Math.min(constants.length, maxConstants);
      for (let i = 0; i < displayCount; i++) {
        const value = formatValue(constants[i], 60);
        const type = getTypeName(constants[i]);
        response.appendResponseLine(`   K[${i}]: (${type}) ${value}`);
      }
      if (constants.length > displayCount) {
        response.appendResponseLine(`   ... ${constants.length - displayCount} more constants`);
      }
      response.appendResponseLine('');
    }

    // ==========================================
    // Actionable Hints
    // Requirement: 5.5
    // ==========================================
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
  },
  handler: async (request, response, context) => {
    const {address: addressInput} = request.params;

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
    const result = vmasmContext.setBreakpoint(address);

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

      // Sync breakpoints to page so they persist across refreshes
      // This updates the Page.addScriptToEvaluateOnNewDocument script
      await syncBreakpointsToPage(page);

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

      response.appendResponseLine('');
      response.appendResponseLine('ℹ️ The breakpoint will trigger when Virtual_IP reaches this address.');
      response.appendResponseLine('   Breakpoints will persist across page refreshes.');
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
      
      // Sync breakpoints to page so the change persists across refreshes
      await syncBreakpointsToPage(page);
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
      
      // Sync breakpoints to page so the change persists across refreshes
      await syncBreakpointsToPage(page);
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
