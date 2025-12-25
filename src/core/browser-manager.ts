/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Browser Manager for rc-devtools-mcp.
 * Manages Chrome browser lifecycle and CDP connections.
 *
 * This module provides a complete browser lifecycle management solution that:
 * - Supports multiple connection modes (default, executable, CDP, self)
 * - Manages persistent browser contexts for session preservation
 * - Handles browser/context lifecycle events
 * - Provides lazy initialization for better performance
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  type BrowserConfig,
  type BrowserStatus,
  browserStatusManager,
  getChromeExecutablePath,
  getSelfCdpUrl,
  getCdpTargets,
  buildBrowserArgs,
  createTempPersistentContextDir,
  cleanupPersistentContextDir,
  getDefaultPersistentContextDir,
  cleanupOldLogFiles,
} from './browser-utils.js';
import {logger} from '../utils/logger.js';
import type {
  Browser,
  BrowserContext,
  Page,
  ChromeReleaseChannel,
} from '../third-party/index.js';
import {puppeteer} from '../third-party/index.js';

// ============================================================================
// Browser Context Info
// ============================================================================

export interface BrowserContextInfo {
  id: string;
  pages: number;
}

/**
 * Lists available browser contexts from a CDP connection.
 * Used to enumerate existing contexts when connecting to a running browser.
 */
export async function listBrowserContexts(
  cdpUrl: string,
): Promise<BrowserContextInfo[]> {
  try {
    // Use CDP targets endpoint to get context info
    const url = new URL(cdpUrl);
    const port = parseInt(url.port || '9222', 10);
    const targets = await getCdpTargets(port);

    // Group targets by browserContextId if available
    const contextMap = new Map<string, number>();

    for (const target of targets) {
      if (target.type === 'page') {
        // Use target id as a proxy for context when full context info isn't available
        const contextId = target.id;
        contextMap.set(contextId, (contextMap.get(contextId) || 0) + 1);
      }
    }

    return Array.from(contextMap.entries()).map(([id, pages]) => ({
      id,
      pages,
    }));
  } catch (error) {
    logger(`Error listing browser contexts: ${error}`);
    return [];
  }
}


// ============================================================================
// Browser Manager
// ============================================================================

export interface BrowserManagerOptions {
  /** Browser configuration specifying connection type */
  config: BrowserConfig;
  /** Optional directory for persistent context storage */
  storageDir?: string;
  /** Whether to run browser in headless mode */
  headless?: boolean;
  /** Whether to open DevTools automatically */
  devtools?: boolean;
  /** Additional browser launch arguments */
  additionalArgs?: string[];
  /** Default viewport size (null for auto) */
  viewport?: {width: number; height: number} | null;
  /** Accept insecure TLS certificates */
  acceptInsecureCerts?: boolean;
  /** Disable Chrome sandboxes (required for Docker/server environments) */
  noSandbox?: boolean;
}

/**
 * Manager for browser and context lifecycle.
 * Provides lazy initialization and proper cleanup of browser resources.
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private browserContext: BrowserContext | null = null;
  private activeBrowsers = new Set<Browser>();
  private persistentContextDir: string | null = null;
  private isDisposed = false;

  constructor(private options: BrowserManagerOptions) {}

  /**
   * Gets the browser instance, initializing it lazily if needed.
   */
  async getBrowser(): Promise<Browser> {
    if (this.isDisposed) {
      throw new Error('BrowserManager has been disposed');
    }

    // Check if we have a valid connected browser
    if (this.browser?.connected) {
      return this.browser;
    }

    logger('Lazily initializing browser');
    browserStatusManager.setStatus({type: 'connecting'});

    try {
      this.browser = await this.connectOrLaunch();
      this.activeBrowsers.add(this.browser);
      this.setupBrowserEventHandlers(this.browser);

      browserStatusManager.setStatus({type: 'connected'});
      return this.browser;
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      browserStatusManager.setStatus({type: 'error', error: errorMsg});
      throw error;
    }
  }

  /**
   * Gets a page from the browser, creating one if necessary.
   */
  async getPage(): Promise<Page> {
    const browser = await this.getBrowser();
    const pages = await browser.pages();

    // Return existing page if available
    if (pages.length > 0 && pages[0]) {
      return pages[0];
    }

    // Create new page
    return await browser.newPage();
  }

  /**
   * Gets all pages from the browser.
   */
  async getPages(): Promise<Page[]> {
    const browser = await this.getBrowser();
    return await browser.pages();
  }

  /**
   * Connects to existing browser or launches a new one based on config.
   */
  private async connectOrLaunch(): Promise<Browser> {
    const {config} = this.options;

    switch (config.connectionType) {
      case 'self':
        return await this.connectToSelf();

      case 'cdp':
        return await this.connectToCdp(config.cdpUrl);

      case 'executable':
        return await this.launchWithExecutable(config.executablePath);

      case 'default':
      default:
        return await this.launchDefault();
    }
  }

  /**
   * Connect to self/host CDP endpoint.
   */
  private async connectToSelf(): Promise<Browser> {
    const selfCdpUrl = await getSelfCdpUrl();
    logger(`Connecting to self CDP at ${selfCdpUrl}`);

    const browser = await puppeteer.connect({
      browserWSEndpoint: selfCdpUrl,
      defaultViewport: this.options.viewport ?? null,
    });

    logger('Connected to self CDP endpoint');
    return browser;
  }

  /**
   * Connect to existing browser via CDP URL.
   */
  private async connectToCdp(cdpUrl: string): Promise<Browser> {
    logger(`Connecting to CDP at ${cdpUrl}`);

    const browser = await puppeteer.connect({
      browserWSEndpoint: cdpUrl,
      defaultViewport: this.options.viewport ?? null,
    });

    logger('Connected to CDP endpoint');
    return browser;
  }

  /**
   * Launch browser with specific executable path.
   */
  private async launchWithExecutable(
    executablePath: string,
  ): Promise<Browser> {
    logger(`Launching browser with executable: ${executablePath}`);
    return await this.launchBrowser(executablePath);
  }

  /**
   * Launch browser with default/detected Chrome.
   */
  private async launchDefault(): Promise<Browser> {
    // Try to find installed Chrome
    const executablePath = await getChromeExecutablePath();

    if (executablePath) {
      logger(`Found Chrome executable at: ${executablePath}`);
      return await this.launchBrowser(executablePath);
    }

    // Fall back to bundled Chrome
    logger('Using bundled Chrome');
    return await this.launchBrowser(undefined, 'chrome');
  }

  /**
   * Launch browser with given executable or channel.
   */
  private async launchBrowser(
    executablePath?: string,
    channel?: ChromeReleaseChannel,
  ): Promise<Browser> {
    browserStatusManager.setStatus({type: 'launching'});

    // Set up persistent context directory
    if (this.options.storageDir) {
      this.persistentContextDir = this.options.storageDir;
      logger(
        `Using provided persistent context directory: ${this.persistentContextDir}`,
      );
    } else {
      this.persistentContextDir = await createTempPersistentContextDir();
      logger(
        `Using temporary persistent context directory: ${this.persistentContextDir}`,
      );
    }

    if (this.persistentContextDir) {
      await fs.promises.mkdir(this.persistentContextDir, {recursive: true});
    }

    // Build launch arguments
    const args = buildBrowserArgs({
      headless: this.options.headless,
      devtools: this.options.devtools,
      additionalArgs: this.options.additionalArgs,
      noSandbox: this.options.noSandbox,
    });

    // Launch options
    // Use 'new' headless mode for better anti-detection (closer to real browser behavior)
    const launchOptions = {
      headless: this.options.headless ? ('new' as const) : false,
      defaultViewport: this.options.viewport ?? null,
      userDataDir: this.persistentContextDir ?? undefined,
      args,
      acceptInsecureCerts: this.options.acceptInsecureCerts,
      pipe: true,
      executablePath: executablePath || undefined,
      channel: executablePath ? undefined : channel,
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const browser = await puppeteer.launch(launchOptions as any);
      logger(`Browser launched with persistent context at: ${this.persistentContextDir}`);
      return browser;
    } catch (error) {
      // Handle case where browser is already running with this profile
      if (
        this.persistentContextDir &&
        (error as Error).message.includes('The browser is already running')
      ) {
        throw new Error(
          `The browser is already running for ${this.persistentContextDir}. ` +
            'Use a different storage directory or close the existing browser.',
          {cause: error},
        );
      }
      throw error;
    }
  }

  /**
   * Set up event handlers for browser lifecycle.
   */
  private setupBrowserEventHandlers(browser: Browser): void {
    browser.on('disconnected', () => {
      logger('Browser disconnected');
      this.activeBrowsers.delete(browser);

      if (this.browser === browser) {
        this.browser = null;
        this.browserContext = null;
        browserStatusManager.setStatus({type: 'disconnected'});
      }
    });
  }

  /**
   * Check if browser is connected.
   */
  isConnected(): boolean {
    return this.browser?.connected ?? false;
  }

  /**
   * Get current browser status.
   */
  getStatus(): BrowserStatus {
    return browserStatusManager.getStatus();
  }

  /**
   * Disposes of all browser resources.
   */
  async dispose(): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;
    logger('Disposing BrowserManager');

    // Close browser context if it exists
    if (this.browserContext) {
      try {
        await this.browserContext.close();
        logger('Browser context closed');
      } catch (error) {
        logger(`Error closing browser context: ${error}`);
      }
      this.browserContext = null;
    }

    // Close all active browsers
    if (this.activeBrowsers.size > 0) {
      logger(`Closing ${this.activeBrowsers.size} active browser(s)`);

      const closePromises = Array.from(this.activeBrowsers).map(
        async browser => {
          try {
            await browser.close();
            logger('Browser closed');
          } catch (error) {
            logger(`Error closing browser: ${error}`);
          }
        },
      );

      await Promise.allSettled(closePromises);
      this.activeBrowsers.clear();
    }

    this.browser = null;

    // Clean up persistent context directory if it was temporary
    if (this.persistentContextDir && !this.options.storageDir) {
      await cleanupPersistentContextDir(this.persistentContextDir);
    }
    this.persistentContextDir = null;

    // Clean up old log files
    await cleanupOldLogFiles();

    browserStatusManager.setStatus({type: 'disconnected'});
    logger('BrowserManager disposed');
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a BrowserManager with default configuration.
 */
export function createDefaultBrowserManager(
  options?: Partial<BrowserManagerOptions>,
): BrowserManager {
  return new BrowserManager({
    config: {connectionType: 'default'},
    ...options,
  });
}

/**
 * Create a BrowserManager that connects to a CDP endpoint.
 */
export function createCdpBrowserManager(
  cdpUrl: string,
  options?: Partial<Omit<BrowserManagerOptions, 'config'>>,
): BrowserManager {
  return new BrowserManager({
    config: {connectionType: 'cdp', cdpUrl},
    ...options,
  });
}

/**
 * Create a BrowserManager that uses a specific executable.
 */
export function createExecutableBrowserManager(
  executablePath: string,
  options?: Partial<Omit<BrowserManagerOptions, 'config'>>,
): BrowserManager {
  return new BrowserManager({
    config: {connectionType: 'executable', executablePath},
    ...options,
  });
}

/**
 * Check current browser status.
 */
export async function checkBrowserStatus(): Promise<{
  platform: string;
  chromeFound: boolean;
  chromePath: string;
  status: BrowserStatus;
}> {
  const chromePath = await getChromeExecutablePath();
  return {
    platform: os.platform(),
    chromeFound: !!chromePath,
    chromePath: chromePath || 'bundled',
    status: browserStatusManager.getStatus(),
  };
}
