/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Code analysis tools for rc-devtools-mcp.
 * Provides JavaScript call graph analysis capabilities.
 */

import {zod} from '../third-party/index.js';
import type {CDPSession} from '../third-party/index.js';
import type {ParseResult, TraceResult} from '../utils/analysis-types.js';
import {
  analyzeFunction,
  buildCallGraph,
} from '../utils/call-graph-analyzer.js';
import {getCdpSession} from '../utils/cdp.js';
import {parseScript} from '../utils/script-parser.js';
import {getAllScriptsWithSource} from '../utils/smart-breakpoint-utils.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './tool-definition.js';

/**
 * Parse result cache per CDP session.
 */
const parseResultCaches = new WeakMap<CDPSession, Map<string, ParseResult>>();

function getParseResultCache(session: CDPSession): Map<string, ParseResult> {
  let cache = parseResultCaches.get(session);
  if (!cache) {
    cache = new Map();
    parseResultCaches.set(session, cache);
  }
  return cache;
}

function getCachedParseResult(
  session: CDPSession,
  scriptId: string,
  url: string,
  source: string
): ParseResult {
  const cache = getParseResultCache(session);
  const cached = cache.get(scriptId);
  
  if (cached) {
    return cached;
  }
  
  const result = parseScript(scriptId, url, source);
  cache.set(scriptId, result);
  
  return result;
}

/**
 * Clear parse result cache for a CDP session.
 */
export function clearParseResultCache(session: CDPSession): void {
  const cache = getParseResultCache(session);
  cache.clear();
}

function formatTraceTree(
  trace: TraceResult,
  prefix = '',
  isLast = true
): string {
  const entries = Object.entries(trace);
  if (entries.length === 0) {
    return '';
  }

  let result = '';
  entries.forEach(([name, value], index) => {
    const isLastEntry = index === entries.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';

    result += `${prefix}${connector}${name}\n`;

    if (value !== 'Leaf' && Object.keys(value).length > 0) {
      result += formatTraceTree(value, prefix + childPrefix, isLastEntry);
    }
  });

  return result;
}

export const analyzeCallGraph = defineTool({
  name: 'analyze_call_graph',
  description: `Analyze the call graph for a specific JavaScript function to understand its callers and callees.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    functionName: zod
      .string()
      .describe('The name of the function to analyze.'),
    upstreamDepth: zod
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .default(3)
      .describe('Maximum depth for upstream trace (callers). Default: 3, Max: 10.'),
    downstreamDepth: zod
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .default(3)
      .describe('Maximum depth for downstream trace (callees). Default: 3, Max: 10.'),
    urlPattern: zod
      .string()
      .optional()
      .describe('Optional regex pattern to filter scripts by URL.'),
  },
  handler: async (request, response, context) => {
    const {functionName, upstreamDepth, downstreamDepth, urlPattern} = request.params;
    const page = context.getSelectedPage();
    const session = await getCdpSession(page);

    response.appendResponseLine(`Analyzing call graph for function: ${functionName}`);
    response.appendResponseLine('');

    const scripts = await getAllScriptsWithSource(session, urlPattern);

    if (scripts.size === 0) {
      response.appendResponseLine('❌ No scripts found.');
      if (urlPattern) {
        response.appendResponseLine(`   URL pattern: ${urlPattern}`);
      }
      return;
    }

    response.appendResponseLine(`📜 Parsed ${scripts.size} script(s)`);

    const parseResults: ParseResult[] = [];
    let totalFunctions = 0;
    let totalCalls = 0;
    let parseErrors = 0;

    for (const [scriptId, {url, source}] of scripts) {
      const result = getCachedParseResult(session, scriptId, url, source);
      parseResults.push(result);
      totalFunctions += result.functions.length;
      totalCalls += result.calls.length;
      parseErrors += result.errors.length;
    }

    response.appendResponseLine(`📊 Found ${totalFunctions} functions, ${totalCalls} call relationships`);
    if (parseErrors > 0) {
      response.appendResponseLine(`⚠️ ${parseErrors} parse error(s) encountered`);
    }
    response.appendResponseLine('');

    const graph = buildCallGraph(parseResults);

    const result = analyzeFunction(graph, functionName, upstreamDepth, downstreamDepth);

    if (!result.found) {
      response.appendResponseLine(`❌ Function "${functionName}" not found in any script.`);
      response.appendResponseLine('');

      if (result.similarFunctions && result.similarFunctions.length > 0) {
        response.appendResponseLine('💡 Similar functions found:');
        for (const similar of result.similarFunctions) {
          const info = graph.functions.get(similar);
          if (info) {
            response.appendResponseLine(`   • ${similar} (${info.scriptUrl}:${info.lineNumber})`);
          } else {
            response.appendResponseLine(`   • ${similar}`);
          }
        }
      }
      return;
    }

    if (result.functionInfo) {
      const info = result.functionInfo;
      response.appendResponseLine(`✅ Function found: ${info.name}`);
      response.appendResponseLine(`   Location: ${info.scriptUrl}:${info.lineNumber}:${info.columnNumber}`);
      response.appendResponseLine(`   Type: ${info.type}`);
      response.appendResponseLine(`   Parameters: ${info.params.length > 0 ? info.params.join(', ') : '(none)'}`);
    }
    response.appendResponseLine('');

    const upstreamEntries = Object.keys(result.upstream);
    response.appendResponseLine(`📥 Upstream (who calls ${functionName}): ${upstreamEntries.length} direct caller(s)`);
    if (upstreamEntries.length > 0) {
      response.appendResponseLine(formatTraceTree(result.upstream));
    } else {
      response.appendResponseLine('   (no callers found)');
    }
    response.appendResponseLine('');

    const downstreamEntries = Object.keys(result.downstream);
    response.appendResponseLine(`📤 Downstream (what ${functionName} calls): ${downstreamEntries.length} direct callee(s)`);
    if (downstreamEntries.length > 0) {
      response.appendResponseLine(formatTraceTree(result.downstream));
    } else {
      response.appendResponseLine('   (no callees found)');
    }
  },
});
