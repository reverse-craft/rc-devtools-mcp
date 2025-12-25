/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Script interception tools for rc-devtools-mcp.
 * Provides script replacement and modification capabilities for reverse engineering.
 */

import {logger} from '../utils/logger.js';
import type {CDPSession, Page} from '../third-party/index.js';
import {zod} from '../third-party/index.js';
import {getCdpSession} from '../utils/cdp.js';
import {initializeDebuggerForPage} from '../utils/debugger-utils.js';
import {getScriptCache} from '../utils/smart-breakpoint-utils.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './tool-definition.js';

/**
 * Script replacement rule stored per page.
 */
interface ScriptReplacementRule {
  id: string;
  urlPattern: string;
  matchedUrl: string;
  oldCode: string;
  newCode: string;
  createdAt: number;
}

/**
 * Store for script replacement rules per page.
 */
const pageReplacementRules = new WeakMap<Page, Map<string, ScriptReplacementRule>>();

/**
 * Track pages that have been initialized with Fetch interception.
 */
const initializedPages = new WeakSet<Page>();

/**
 * Counter for generating unique rule IDs.
 */
let ruleIdCounter = 0;

/**
 * Get or create the replacement rules map for a page.
 */
function getPageRules(page: Page): Map<string, ScriptReplacementRule> {
  let rules = pageReplacementRules.get(page);
  if (!rules) {
    rules = new Map();
    pageReplacementRules.set(page, rules);
  }
  return rules;
}


/**
 * Handle Fetch.requestPaused event.
 */
async function handleRequestPaused(
  session: CDPSession,
  page: Page,
  event: any
): Promise<void> {
  const {requestId, request} = event;
  const url = request.url;
  const rules = getPageRules(page);

  // Find matching rule by exact URL
  let matchedRule: ScriptReplacementRule | undefined;
  for (const rule of rules.values()) {
    if (rule.matchedUrl === url) {
      matchedRule = rule;
      break;
    }
  }

  if (!matchedRule) {
    try {
      await session.send('Fetch.continueRequest', {requestId});
    } catch (error) {
      logger(`[intercept] Failed to continue request: ${error}`);
    }
    return;
  }

  try {
    const response = await session.send('Fetch.getResponseBody', {requestId});
    const responseResult = response as {body: string; base64Encoded: boolean};

    let originalBody: string;
    if (responseResult.base64Encoded) {
      originalBody = Buffer.from(responseResult.body, 'base64').toString('utf-8');
    } else {
      originalBody = responseResult.body;
    }

    if (!originalBody.includes(matchedRule.oldCode)) {
      logger(`[intercept] ❌ Old code not found in ${url}`);
      await session.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: 200,
        responseHeaders: [{name: 'Content-Type', value: 'application/javascript'}],
        body: responseResult.body,
      });
      return;
    }

    const modifiedBody = originalBody.replace(matchedRule.oldCode, matchedRule.newCode);
    const base64Body = Buffer.from(modifiedBody).toString('base64');

    await session.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [{name: 'Content-Type', value: 'application/javascript'}],
      body: base64Body,
    });

    logger(`[intercept] ✅ Replaced code in ${url}`);
  } catch (error) {
    logger(`[intercept] Error: ${error}`);
    try {
      await session.send('Fetch.continueRequest', {requestId});
    } catch {
      // Ignore
    }
  }
}

/**
 * Enable Fetch interception with current rules.
 */
async function enableFetchInterception(session: CDPSession, page: Page): Promise<void> {
  const rules = getPageRules(page);

  if (rules.size === 0) {
    try {
      await session.send('Fetch.disable');
      logger('[intercept] Fetch disabled (no rules)');
    } catch {
      // Ignore
    }
    return;
  }

  const patterns: Array<{urlPattern: string; requestStage: 'Request' | 'Response'}> = [];
  for (const rule of rules.values()) {
    patterns.push({
      urlPattern: rule.matchedUrl,
      requestStage: 'Response' as const,
    });
  }

  await session.send('Fetch.enable', {patterns});
  logger(`[intercept] Fetch enabled with ${patterns.length} URL(s)`);
}

/**
 * Initialize Fetch interception for a page.
 * Sets up event listeners and navigation handlers to persist rules across page refreshes.
 */
async function initializeFetchInterception(page: Page): Promise<CDPSession> {
  const session = await getCdpSession(page);

  if (initializedPages.has(page)) {
    return session;
  }
  initializedPages.add(page);

  // Listen for Fetch.requestPaused events
  session.on('Fetch.requestPaused', (event: any) => {
    handleRequestPaused(session, page, event);
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
    const rules = getPageRules(page);
    if (rules.size === 0) return;

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
      logger('[intercept] Main frame loading, re-enabling Fetch interception...');
      try {
        await enableFetchInterception(session, page);
      } catch (err) {
        logger(`[intercept] Error re-enabling Fetch: ${err}`);
      }
    }
  });

  // Enable Page domain for navigation events
  try {
    await session.send('Page.enable');
  } catch {
    // Ignore
  }

  logger('[intercept] Fetch interception initialized');
  return session;
}


export const replaceScript = defineTool({
  name: 'replace_script',
  description: `Replace a JavaScript code snippet in scripts matching a URL pattern. Uses network interception to modify scripts before execution.

**IMPORTANT:** Changes take effect after page refresh. Rules persist across page refreshes until removed.

This tool:
1. Finds loaded scripts matching the URL pattern (regex)
2. Registers an interception rule for the matched script URL
3. On page refresh, intercepts and modifies the script

If no scripts match the pattern or old code is not found, an error is reported.

Use cases:
- Modify third-party scripts
- Inject debugging code
- Bypass anti-debugging measures
- Test code changes without modifying source`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    urlPattern: zod
      .string()
      .describe('URL pattern (regex) to match scripts. Examples: ".*main\\.js.*", ".*jquery.*"'),
    oldCode: zod
      .string()
      .describe('The original code snippet to replace. Must match exactly.'),
    newCode: zod
      .string()
      .describe('The new code snippet.'),
  },
  handler: async (request, response, context) => {
    const {urlPattern, oldCode, newCode} = request.params;
    const page = context.getSelectedPage();

    if (!oldCode.trim()) {
      response.appendResponseLine('❌ Error: oldCode cannot be empty.');
      return;
    }

    if (oldCode === newCode) {
      response.appendResponseLine('❌ Error: oldCode and newCode are identical.');
      return;
    }

    // Initialize debugger to populate script cache
    const debuggerSession = await initializeDebuggerForPage(page, { forceEnable: true });
    const scriptCache = getScriptCache(debuggerSession);

    let urlRegex: RegExp;
    try {
      urlRegex = new RegExp(urlPattern, 'i');
    } catch (error) {
      response.appendResponseLine(`❌ Error: Invalid URL pattern: ${error}`);
      return;
    }

    // Find matching scripts
    const matchingScripts: Array<{scriptId: string; url: string}> = [];
    for (const [scriptId, scriptInfo] of scriptCache.entries()) {
      if (scriptInfo.url && urlRegex.test(scriptInfo.url)) {
        matchingScripts.push({scriptId, url: scriptInfo.url});
      }
    }

    if (matchingScripts.length === 0) {
      response.appendResponseLine(`❌ Error: No loaded scripts match "${urlPattern}"`);
      response.appendResponseLine('');
      response.appendResponseLine('💡 Tips:');
      response.appendResponseLine('   • Ensure the script is loaded');
      response.appendResponseLine('   • Use `list_network_requests` with resourceTypes=["script"]');
      return;
    }

    if (matchingScripts.length > 1) {
      response.appendResponseLine(`⚠️ Multiple scripts match. Using first:`);
      for (const s of matchingScripts.slice(0, 3)) {
        response.appendResponseLine(`   • ${s.url}`);
      }
      if (matchingScripts.length > 3) {
        response.appendResponseLine(`   ... and ${matchingScripts.length - 3} more`);
      }
      response.appendResponseLine('');
    }

    const matchedScript = matchingScripts[0];
    const ruleId = `rule_${Date.now()}_${++ruleIdCounter}`;

    const rule: ScriptReplacementRule = {
      id: ruleId,
      urlPattern,
      matchedUrl: matchedScript.url,
      oldCode,
      newCode,
      createdAt: Date.now(),
    };

    const rules = getPageRules(page);
    rules.set(ruleId, rule);

    // Initialize Fetch interception (with navigation listener)
    const session = await initializeFetchInterception(page);
    await enableFetchInterception(session, page);

    response.appendResponseLine('✅ Script replacement rule registered.');
    response.appendResponseLine('');
    response.appendResponseLine(`**Rule ID:** \`${ruleId}\``);
    response.appendResponseLine(`**Matched URL:** ${matchedScript.url}`);
    response.appendResponseLine(`**Old Code:** \`${oldCode.substring(0, 50)}${oldCode.length > 50 ? '...' : ''}\``);
    response.appendResponseLine(`**New Code:** \`${newCode.substring(0, 50)}${newCode.length > 50 ? '...' : ''}\``);
    response.appendResponseLine('');
    response.appendResponseLine('⚠️ **Refresh the page** for the replacement to take effect.');
  },
});


export const listScriptReplacements = defineTool({
  name: 'list_script_replacements',
  description: 'List all active script replacement rules for the current page.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {},
  handler: async (_request, response, context) => {
    const page = context.getSelectedPage();
    const rules = getPageRules(page);

    if (rules.size === 0) {
      response.appendResponseLine('📋 No script replacement rules.');
      response.appendResponseLine('Use `replace_script` to add one.');
      return;
    }

    response.appendResponseLine(`📋 **${rules.size} rule${rules.size === 1 ? '' : 's'}:**`);
    response.appendResponseLine('');

    for (const rule of rules.values()) {
      response.appendResponseLine('---');
      response.appendResponseLine(`**ID:** \`${rule.id}\``);
      response.appendResponseLine(`**Pattern:** ${rule.urlPattern}`);
      response.appendResponseLine(`**URL:** ${rule.matchedUrl}`);
      response.appendResponseLine(`**Old Code:**`);
      response.appendResponseLine('```javascript');
      response.appendResponseLine(rule.oldCode.length > 200 ? rule.oldCode.substring(0, 200) + '...' : rule.oldCode);
      response.appendResponseLine('```');
      response.appendResponseLine(`**New Code:**`);
      response.appendResponseLine('```javascript');
      response.appendResponseLine(rule.newCode.length > 200 ? rule.newCode.substring(0, 200) + '...' : rule.newCode);
      response.appendResponseLine('```');
    }
  },
});

export const removeScriptReplacement = defineTool({
  name: 'remove_script_replacement',
  description: 'Remove a script replacement rule by its ID.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {
    ruleId: zod.string().describe('The rule ID to remove.'),
  },
  handler: async (request, response, context) => {
    const {ruleId} = request.params;
    const page = context.getSelectedPage();
    const rules = getPageRules(page);

    if (!rules.has(ruleId)) {
      response.appendResponseLine(`❌ Rule not found: \`${ruleId}\``);
      response.appendResponseLine('Use `list_script_replacements` to see active rules.');
      return;
    }

    rules.delete(ruleId);

    const session = await getCdpSession(page);
    await enableFetchInterception(session, page);

    response.appendResponseLine(`✅ Rule removed: \`${ruleId}\``);
  },
});

export const clearScriptReplacements = defineTool({
  name: 'clear_script_replacements',
  description: 'Remove all script replacement rules for the current page.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: false,
  },
  schema: {},
  handler: async (_request, response, context) => {
    const page = context.getSelectedPage();
    const rules = getPageRules(page);
    const count = rules.size;

    if (count === 0) {
      response.appendResponseLine('📋 No rules to clear.');
      return;
    }

    rules.clear();

    const session = await getCdpSession(page);
    await enableFetchInterception(session, page);

    response.appendResponseLine(`✅ Cleared ${count} rule${count === 1 ? '' : 's'}.`);
  },
});
