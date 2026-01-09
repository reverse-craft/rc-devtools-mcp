/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from './logger.js';
import type {CDPSession, Page} from '../third-party/index.js';

import {getCdpSession} from './cdp.js';
import type {CallFrame} from './debugger-utils.js';
import {getDebuggerState, initializeDebuggerForPage} from './debugger-utils.js';

/**
 * Result of a smart navigation operation.
 */
export interface SmartNavigationResult {
  /** The outcome of the navigation */
  status: 'loaded' | 'paused' | 'timeout' | 'error';

  /** Final URL after navigation (for 'loaded' status) */
  url?: string;

  /** Call frames when paused (for 'paused' status) */
  callFrames?: CallFrame[];

  /** Error message (for 'error' or 'timeout' status) */
  error?: string;
}

/**
 * Options for smart navigation.
 */
export interface SmartNavigationOptions {
  /** Navigation timeout in milliseconds */
  timeout?: number;

  /** Whether to ignore cache (for reload) */
  ignoreCache?: boolean;

  /** Whether the debugger is enabled for this navigation */
  debuggerEnabled?: boolean;
}

/** Default navigation timeout in milliseconds */
const DEFAULT_TIMEOUT = 30000;


/**
 * Core smart navigation function that handles the race condition between
 * page load and debugger pause events.
 *
 * Uses Promise.race pattern to return control when either:
 * 1. The page load event fires (normal completion)
 * 2. The debugger pauses (breakpoint/debugger statement hit)
 * 3. A timeout occurs (fallback safety)
 *
 * @param session - CDP session for the page
 * @param navigateAction - Function that triggers the navigation
 * @param options - Navigation options
 * @param debuggerState - Optional debugger state for checking if debugger is disabled
 * @returns SmartNavigationResult indicating the outcome
 */
export async function smartNavigate(
  session: CDPSession,
  navigateAction: () => Promise<void>,
  options: SmartNavigationOptions,
  debuggerState?: {userDisabled: boolean},
): Promise<SmartNavigationResult> {
  // Enable Page domain to receive loadEventFired events
  try {
    await session.send('Page.enable');
  } catch {
    // Ignore - may already be enabled
  }

  return new Promise(resolve => {
    let resolved = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    // Cleanup function to remove listeners and prevent duplicate execution
    const cleanup = () => {
      if (resolved) return;
      resolved = true;

      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }

      try {
        session.off('Debugger.paused', onPaused);
        session.off('Page.loadEventFired', onLoad);
      } catch (error) {
        logger('[smart-navigation] Error during cleanup:', error);
      }
    };

    // Handler for debugger pause events
    const onPaused = (params: {callFrames?: CallFrame[]}) => {
      if (resolved) return;
      cleanup();
      logger('[smart-navigation] Debugger paused during navigation');
      resolve({
        status: 'paused',
        callFrames: params.callFrames,
      });
    };

    // Handler for page load events
    const onLoad = () => {
      if (resolved) return;
      cleanup();
      logger('[smart-navigation] Page loaded successfully');
      resolve({
        status: 'loaded',
      });
    };

    // Only listen for debugger pause if debugger is enabled
    const shouldListenForPause =
      options.debuggerEnabled !== false &&
      (!debuggerState || !debuggerState.userDisabled);

    // Setup listeners BEFORE triggering navigation
    if (shouldListenForPause) {
      session.on('Debugger.paused', onPaused);
    }
    session.on('Page.loadEventFired', onLoad);

    // Setup timeout
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    timeoutId = setTimeout(() => {
      if (resolved) return;
      cleanup();
      logger('[smart-navigation] Navigation timeout');
      resolve({
        status: 'timeout',
        error: `Navigation timeout after ${timeout}ms`,
      });
    }, timeout);

    // Trigger navigation
    navigateAction().catch(error => {
      if (resolved) return;
      cleanup();
      logger('[smart-navigation] Navigation error:', error);
      resolve({
        status: 'error',
        error: error.message || String(error),
      });
    });
  });
}

/**
 * Handles page navigation with debugger-aware race condition handling.
 * Uses CDP primitives instead of Puppeteer's goto() to avoid deadlocks
 * when the debugger pauses during navigation.
 */
export class SmartNavigator {
  private page: Page;
  private session: CDPSession | undefined;

  constructor(page: Page, session?: CDPSession) {
    this.page = page;
    this.session = session;
  }

  /**
   * Get or create the CDP session for this navigator.
   */
  private async getSession(): Promise<CDPSession> {
    if (!this.session) {
      this.session = await getCdpSession(this.page);
    }
    return this.session;
  }

  /**
   * Navigate to a URL with debugger-aware waiting.
   * Returns immediately if debugger pauses during navigation.
   */
  async navigateToUrl(
    url: string,
    options?: SmartNavigationOptions,
  ): Promise<SmartNavigationResult> {
    const session = await this.getSession();
    const debuggerState = getDebuggerState(this.page);

    // Initialize debugger if enabled
    if (options?.debuggerEnabled !== false && !debuggerState.userDisabled) {
      await initializeDebuggerForPage(this.page);
    }

    const result = await smartNavigate(
      session,
      async () => {
        await session.send('Page.navigate', {url});
      },
      options ?? {},
      debuggerState,
    );

    // Update result with final URL if loaded
    if (result.status === 'loaded') {
      result.url = this.page.url();
    }

    // Update debugger state if paused
    if (result.status === 'paused' && result.callFrames) {
      debuggerState.isPaused = true;
      debuggerState.pausedCallFrames = result.callFrames;
    }

    return result;
  }

  /**
   * Navigate back in history with debugger-aware waiting.
   */
  async navigateBack(
    options?: SmartNavigationOptions,
  ): Promise<SmartNavigationResult> {
    const session = await this.getSession();
    const debuggerState = getDebuggerState(this.page);

    // Initialize debugger if enabled
    // Only initialize if debugger is not disabled by user and enableDebugger option is not false
    if (options?.debuggerEnabled !== false && !debuggerState.userDisabled) {
      await initializeDebuggerForPage(this.page);
    }

    // Get navigation history
    const history = (await session.send('Page.getNavigationHistory')) as {
      currentIndex: number;
      entries: Array<{id: number; url: string}>;
    };

    if (history.currentIndex <= 0) {
      return {
        status: 'error',
        error: 'Cannot navigate back: already at the beginning of history',
      };
    }

    const targetEntry = history.entries[history.currentIndex - 1];

    const result = await smartNavigate(
      session,
      async () => {
        await session.send('Page.navigateToHistoryEntry', {
          entryId: targetEntry.id,
        });
      },
      options ?? {},
      debuggerState,
    );

    if (result.status === 'loaded') {
      result.url = this.page.url();
    }

    if (result.status === 'paused' && result.callFrames) {
      debuggerState.isPaused = true;
      debuggerState.pausedCallFrames = result.callFrames;
    }

    return result;
  }

  /**
   * Navigate forward in history with debugger-aware waiting.
   */
  async navigateForward(
    options?: SmartNavigationOptions,
  ): Promise<SmartNavigationResult> {
    const session = await this.getSession();
    const debuggerState = getDebuggerState(this.page);

    // Initialize debugger if enabled
    // Only initialize if debugger is not disabled by user and enableDebugger option is not false
    if (options?.debuggerEnabled !== false && !debuggerState.userDisabled) {
      await initializeDebuggerForPage(this.page);
    }

    // Get navigation history
    const history = (await session.send('Page.getNavigationHistory')) as {
      currentIndex: number;
      entries: Array<{id: number; url: string}>;
    };

    if (history.currentIndex >= history.entries.length - 1) {
      return {
        status: 'error',
        error: 'Cannot navigate forward: already at the end of history',
      };
    }

    const targetEntry = history.entries[history.currentIndex + 1];

    const result = await smartNavigate(
      session,
      async () => {
        await session.send('Page.navigateToHistoryEntry', {
          entryId: targetEntry.id,
        });
      },
      options ?? {},
      debuggerState,
    );

    if (result.status === 'loaded') {
      result.url = this.page.url();
    }

    if (result.status === 'paused' && result.callFrames) {
      debuggerState.isPaused = true;
      debuggerState.pausedCallFrames = result.callFrames;
    }

    return result;
  }

  /**
   * Reload the page with debugger-aware waiting.
   */
  async reload(options?: SmartNavigationOptions): Promise<SmartNavigationResult> {
    const session = await this.getSession();
    const debuggerState = getDebuggerState(this.page);

    // Initialize debugger if enabled
    // Only initialize if debugger is not disabled by user and enableDebugger option is not false
    if (options?.debuggerEnabled !== false && !debuggerState.userDisabled) {
      await initializeDebuggerForPage(this.page);
    }

    const result = await smartNavigate(
      session,
      async () => {
        await session.send('Page.reload', {
          ignoreCache: options?.ignoreCache ?? false,
        });
      },
      options ?? {},
      debuggerState,
    );

    if (result.status === 'loaded') {
      result.url = this.page.url();
    }

    if (result.status === 'paused' && result.callFrames) {
      debuggerState.isPaused = true;
      debuggerState.pausedCallFrames = result.callFrames;
    }

    return result;
  }
}
