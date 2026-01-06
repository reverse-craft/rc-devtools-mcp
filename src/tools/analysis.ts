/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Code analysis tools for rc-devtools-mcp.
 * This module is reserved for future analysis capabilities.
 */

import type {CDPSession} from '../third-party/index.js';
import type {ParseResult} from '../utils/analysis-types.js';

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

/**
 * Clear parse result cache for a CDP session.
 */
export function clearParseResultCache(session: CDPSession): void {
  const cache = getParseResultCache(session);
  cache.clear();
}
