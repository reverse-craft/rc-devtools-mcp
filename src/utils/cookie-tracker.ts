/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Page} from '../third-party/index.js';

import {getCdpSession} from './cdp.js';
import {logger} from './logger.js';

/**
 * Cookie tracking state per page.
 */
interface CookieTrackingState {
  enabled: boolean;
  scriptIdentifier: string | null;
}

/**
 * WeakMap-based storage for per-page cookie tracking state.
 */
const cookieTrackingStates = new WeakMap<Page, CookieTrackingState>();

/**
 * Binding name for cookie tracker callback.
 */
const COOKIE_TRACKER_BINDING = '__cookieTrackerCallback';

/**
 * Get or create the cookie tracking state for a page.
 */
function getTrackingState(page: Page): CookieTrackingState {
  let state = cookieTrackingStates.get(page);
  if (!state) {
    state = {
      enabled: false,
      scriptIdentifier: null,
    };
    cookieTrackingStates.set(page, state);
  }
  return state;
}

/**
 * JavaScript source code to inject into pages for cookie interception.
 * This script overrides document.cookie setter to log and report cookie operations.
 */
const COOKIE_HOOK_SCRIPT = `
(function() {
  const originalDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  if (!originalDescriptor) return;

  const originalSetter = originalDescriptor.set;
  const originalGetter = originalDescriptor.get;

  function parseStackTrace() {
    try {
      const stack = new Error().stack;
      if (!stack) return { url: 'unknown', line: -1, column: -1 };

      const lines = stack.split('\\n');
      // Skip first 3 frames: Error, parseStackTrace, setter
      for (let i = 3; i < lines.length; i++) {
        const line = lines[i];
        // Match Chrome format: "at functionName (url:line:column)" or "at url:line:column"
        const match = line.match(/at\\s+(?:[^(]+\\s+\\()?([^:]+):(\\d+):(\\d+)\\)?/);
        if (match) {
          return {
            url: match[1],
            line: parseInt(match[2], 10),
            column: parseInt(match[3], 10)
          };
        }
      }
    } catch (e) {
      // Ignore parsing errors
    }
    return { url: 'unknown', line: -1, column: -1 };
  }

  function parseCookie(cookieStr) {
    const eqIndex = cookieStr.indexOf('=');
    if (eqIndex === -1) {
      return { name: cookieStr.trim(), value: '' };
    }
    const name = cookieStr.substring(0, eqIndex).trim();
    const rest = cookieStr.substring(eqIndex + 1);
    const semiIndex = rest.indexOf(';');
    const value = semiIndex === -1 ? rest.trim() : rest.substring(0, semiIndex).trim();
    return { name, value };
  }

  Object.defineProperty(document, 'cookie', {
    get: function() {
      return originalGetter ? originalGetter.call(this) : '';
    },
    set: function(value) {
      try {
        const source = parseStackTrace();
        const { name, value: cookieValue } = parseCookie(value);

        console.log('[CookieTracker] name:', name, '| value:', cookieValue, '| file:', source.url, '| line:', source.line, '| column:', source.column);

        if (typeof window.${COOKIE_TRACKER_BINDING} === 'function') {
          const payload = JSON.stringify({
            name: name,
            value: cookieValue,
            rawCookie: value,
            source: source,
            timestamp: Date.now()
          });
          window.${COOKIE_TRACKER_BINDING}(payload);
        }
      } catch (e) {
        // Ensure cookie operation completes even if logging fails
      }

      if (originalSetter) {
        return originalSetter.call(this, value);
      }
    },
    configurable: true,
    enumerable: true
  });
})();
`;

/**
 * Enable cookie tracking for a page.
 * Registers CDP binding and injects persistent hook script.
 * @param page - The page to enable tracking for
 */
export async function enableCookieTracking(page: Page): Promise<void> {
  const state = getTrackingState(page);

  // Already enabled, skip
  if (state.enabled) {
    return;
  }

  const session = await getCdpSession(page);

  // Enable Runtime domain for binding
  await session.send('Runtime.enable');

  // Register binding before script injection
  try {
    await session.send('Runtime.addBinding', {
      name: COOKIE_TRACKER_BINDING,
    });
  } catch (e) {
    // Binding might already exist, ignore
  }

  // Listen for binding calls
  session.on('Runtime.bindingCalled', (params: {name: string; payload: string}) => {
    if (params.name === COOKIE_TRACKER_BINDING) {
      try {
        const data = JSON.parse(params.payload);
        logger(`[CookieTracker] Cookie set: ${data.name}=${data.value} from ${data.source.url}:${data.source.line}:${data.source.column}`);
      } catch (e) {
        logger('[CookieTracker] Failed to parse cookie event payload');
      }
    }
  });

  // Enable Page domain for script injection
  await session.send('Page.enable');

  // Inject the hook script
  const result = await session.send('Page.addScriptToEvaluateOnNewDocument', {
    source: COOKIE_HOOK_SCRIPT,
  });

  state.scriptIdentifier = result.identifier;
  state.enabled = true;

  logger('[CookieTracker] Cookie tracking enabled for page');
}

/**
 * Check if cookie tracking is enabled for a page.
 * @param page - The page to check
 * @returns true if tracking is enabled
 */
export function isCookieTrackingEnabled(page: Page): boolean {
  const state = cookieTrackingStates.get(page);
  return state?.enabled ?? false;
}
