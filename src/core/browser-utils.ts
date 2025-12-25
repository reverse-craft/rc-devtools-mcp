/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Browser management utilities for rc-devtools-mcp.
 * Provides CDP connection, Chrome detection, and browser launch utilities.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, type ChildProcess} from 'node:child_process';

import {logger} from '../utils/logger.js';

// ============================================================================
// Version and User-Agent Management
// ============================================================================

const VERSION = '0.1.0';

let cachedUserAgent: string | undefined;

/**
 * Gets the User-Agent string with product name and version information.
 * Computed once and cached for efficiency.
 */
export function getUserAgent(): string {
  if (cachedUserAgent) {
    return cachedUserAgent;
  }
  const platform = `${os.platform()} ${os.arch()}`;
  cachedUserAgent = `RcDevToolsMCP/${VERSION} (${platform})`;
  return cachedUserAgent;
}

/**
 * Gets the current version of the MCP server.
 */
export function getVersion(): string {
  return VERSION;
}

// ============================================================================
// Browser Status Management
// ============================================================================

export type BrowserStatus =
  | {type: 'disconnected'}
  | {type: 'connecting'}
  | {type: 'launching'}
  | {type: 'connected'}
  | {type: 'error'; error: string};

/**
 * Browser status manager for tracking connection state.
 */
export class BrowserStatusManager {
  status: BrowserStatus = {type: 'disconnected'};
  private listeners = new Set<(status: BrowserStatus) => void>();

  getStatus(): BrowserStatus {
    return this.status;
  }

  setStatus(status: BrowserStatus): void {
    this.status = status;
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch (error) {
        logger(`Error in status listener: ${error}`);
      }
    }
  }

  onStatusChange(listener: (status: BrowserStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  isConnected(): boolean {
    return this.status.type === 'connected';
  }
}

// Global status manager instance
export const browserStatusManager = new BrowserStatusManager();

// ============================================================================
// CDP Connection Utilities
// ============================================================================

/**
 * Attempts to fetch the WebSocket CDP URL from a running browser instance.
 *
 * @param port - The debug port to connect to (default: 9222)
 * @returns The WebSocket debugger URL
 */
export async function getSelfCdpUrl(port = 9222): Promise<string> {
  const maxRetries = 2;
  const timeoutMs = 3_000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`http://localhost:${port}/json/version`, {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch CDP version info: ${response.status} ${response.statusText}`,
        );
      }

      const data = (await response.json()) as {
        webSocketDebuggerUrl?: string;
      };

      if (
        typeof data === 'object' &&
        data !== null &&
        'webSocketDebuggerUrl' in data &&
        typeof data.webSocketDebuggerUrl === 'string'
      ) {
        return data.webSocketDebuggerUrl;
      }

      throw new Error(
        '`webSocketDebuggerUrl` is missing or not a string in response',
      );
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger(`Attempt ${attempt + 1} to fetch CDP URL failed: ${errorMessage}`);

      if (isLastAttempt) {
        logger(`Failed to retrieve CDP URL after retries: ${error}`);
        throw error;
      }

      // Brief backoff before retrying
      await new Promise(resolve => setTimeout(resolve, 500));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error('Unexpected error fetching CDP URL');
}

export interface CdpTarget {
  id: string;
  type: string;
  url: string;
  browserContextId?: string;
}

/**
 * Get list of available targets from a CDP endpoint.
 *
 * @param port - The debug port to query (default: 9222)
 * @returns Array of target information
 */
export async function getCdpTargets(port = 9222): Promise<CdpTarget[]> {
  try {
    const response = await fetch(`http://localhost:${port}/json/list`);
    if (!response.ok) {
      throw new Error(`Failed to fetch CDP targets: ${response.status}`);
    }
    return (await response.json()) as CdpTarget[];
  } catch (error) {
    logger(`Error listing CDP targets: ${error}`);
    return [];
  }
}


// ============================================================================
// Path Expansion Utilities
// ============================================================================

/**
 * Expands ~ and . in paths to their full equivalents.
 * @param inputPath - The path to expand
 * @param workspaceRoot - Optional workspace root for . expansion
 * @returns The expanded path
 */
export function expandPath(
  inputPath: string | undefined,
  workspaceRoot?: string,
): string | undefined {
  if (!inputPath) {
    return inputPath;
  }

  // Expand ~ to home directory
  if (inputPath.startsWith('~')) {
    return path.join(os.homedir(), inputPath.slice(1));
  }

  // Expand . to workspace root or current directory
  if (inputPath.startsWith('./') || inputPath === '.') {
    const root = workspaceRoot ?? process.cwd();
    return path.join(root, inputPath.replace(/^\./, ''));
  }

  return inputPath;
}

/**
 * Expands a command string, handling both the executable path and arguments.
 * @param command - The command string to expand
 * @param workspaceRoot - Optional workspace root for . expansion
 * @returns The expanded command string
 */
export function expandCommandPath(
  command: string,
  workspaceRoot?: string,
): string {
  const parts = command.split(' ');
  for (let i = 0; i < parts.length; i++) {
    parts[i] = expandPath(parts[i], workspaceRoot) ?? parts[i];
  }
  return parts.join(' ');
}

// ============================================================================
// Chrome Executable Path Detection
// ============================================================================

/**
 * Determines the Chrome executable path for the current platform.
 * This helps use the user's actual Chrome installation instead of bundled Chromium,
 * which provides better fingerprint authenticity and reduces bot detection.
 * @returns Chrome executable path or undefined if not found
 */
export async function getChromeExecutablePath(): Promise<string | undefined> {
  const platform = os.platform();
  const possiblePaths: string[] = [];

  switch (platform) {
    case 'darwin': // macOS
      possiblePaths.push(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
        '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      );
      break;

    case 'win32': {
      const programFiles =
        process.env['PROGRAMFILES'] || 'C:\\Program Files';
      const programFilesX86 =
        process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
      const localAppData =
        process.env['LOCALAPPDATA'] ||
        path.join(os.homedir(), 'AppData', 'Local');

      possiblePaths.push(
        path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(
          programFilesX86,
          'Google',
          'Chrome',
          'Application',
          'chrome.exe',
        ),
        path.join(
          localAppData,
          'Google',
          'Chrome',
          'Application',
          'chrome.exe',
        ),
        path.join(
          programFiles,
          'Google',
          'Chrome Beta',
          'Application',
          'chrome.exe',
        ),
        path.join(
          programFilesX86,
          'Google',
          'Chrome Beta',
          'Application',
          'chrome.exe',
        ),
        path.join(
          localAppData,
          'Google',
          'Chrome Beta',
          'Application',
          'chrome.exe',
        ),
        path.join(
          programFiles,
          'Google',
          'Chrome Dev',
          'Application',
          'chrome.exe',
        ),
        path.join(
          programFilesX86,
          'Google',
          'Chrome Dev',
          'Application',
          'chrome.exe',
        ),
        path.join(
          localAppData,
          'Google',
          'Chrome Dev',
          'Application',
          'chrome.exe',
        ),
        path.join(
          programFiles,
          'Google',
          'Chrome SxS',
          'Application',
          'chrome.exe',
        ),
        path.join(
          programFilesX86,
          'Google',
          'Chrome SxS',
          'Application',
          'chrome.exe',
        ),
        path.join(
          localAppData,
          'Google',
          'Chrome SxS',
          'Application',
          'chrome.exe',
        ),
        path.join(programFiles, 'Chromium', 'Application', 'chrome.exe'),
        path.join(programFilesX86, 'Chromium', 'Application', 'chrome.exe'),
        path.join(localAppData, 'Chromium', 'Application', 'chrome.exe'),
      );
      break;
    }

    case 'linux':
      possiblePaths.push(
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome-beta',
        '/usr/bin/google-chrome-unstable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium',
        '/var/lib/snapd/snap/bin/chromium',
        '/usr/local/bin/chrome',
        '/usr/local/bin/google-chrome',
      );
      break;

    default:
      logger(`Unsupported platform: ${platform}`);
      return undefined;
  }

  // Check each possible path and return the first one that exists
  for (const executablePath of possiblePaths) {
    try {
      await fs.promises.access(executablePath);
      logger(`Found Chrome executable at: ${executablePath}`);
      return executablePath;
    } catch {
      continue;
    }
  }

  logger(
    `No Chrome executable found on ${platform}. Checked paths: ${possiblePaths.join(', ')}`,
  );
  return undefined;
}

/**
 * Common viewport resolutions used by real users.
 */
const COMMON_VIEWPORTS = [
  {width: 1920, height: 1080},
  {width: 1440, height: 900},
  {width: 1366, height: 768},
  {width: 1536, height: 864},
  {width: 1280, height: 720},
];

/**
 * Get a random common viewport resolution.
 */
export function getRandomViewport(): {width: number; height: number} {
  return COMMON_VIEWPORTS[
    Math.floor(Math.random() * COMMON_VIEWPORTS.length)
  ];
}

/**
 * Random delay utility for human-like behavior.
 * @param min Minimum delay in milliseconds
 * @param max Maximum delay in milliseconds
 */
export async function randomDelay(
  min = 100,
  max = 500,
): Promise<void> {
  const delay = Math.random() * (max - min) + min;
  await new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Typing delay utility for human-like keyboard input.
 * @param baseDelay Base delay between keystrokes
 * @param variance Random variance to add
 */
export function getTypingDelay(baseDelay = 50, variance = 100): number {
  return baseDelay + Math.random() * variance;
}


// ============================================================================
// Persistent Context Management
// ============================================================================

/**
 * Default directory for persistent browser context storage.
 */
export function getDefaultPersistentContextDir(): string {
  return path.join(
    os.homedir(),
    '.cache',
    'rc-devtools-mcp',
    'browser-session',
  );
}

/**
 * Create a temporary persistent context directory.
 */
export async function createTempPersistentContextDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `rc-devtools-mcp-session-${Date.now()}`,
  );
  await fs.promises.mkdir(dir, {recursive: true});
  logger(`Created temporary persistent context directory: ${dir}`);
  return dir;
}

/**
 * Clean up a persistent context directory.
 * @param dir - Directory path to clean up
 * @param force - If true, remove even if it's not a temp directory
 */
export async function cleanupPersistentContextDir(
  dir: string,
  force = false,
): Promise<void> {
  // Only clean up temp directories by default
  if (!force && !dir.startsWith(os.tmpdir())) {
    logger(`Preserving persistent context directory: ${dir}`);
    return;
  }

  try {
    await fs.promises.rm(dir, {recursive: true, force: true});
    logger(`Cleaned up persistent context directory: ${dir}`);
  } catch (error) {
    logger(`Error cleaning up persistent context directory: ${error}`);
  }
}

// ============================================================================
// Browser Launch Arguments
// ============================================================================

/**
 * Default browser launch arguments for optimal automation experience.
 */
export function getDefaultBrowserArgs(): string[] {
  return [
    '--enable-extensions',
    '--disable-infobars',
    '--disable-popup-blocking',
    '--hide-crash-restore-bubble',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ];
}

/**
 * Additional arguments for headless mode.
 */
export function getHeadlessBrowserArgs(): string[] {
  const args = [
    '--screen-info={3840x2160}',
    '--disable-gpu',
    '--disable-software-rasterizer',
  ];

  if (os.platform() === 'linux') {
    args.push(
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-zygote',
      '--font-render-hinting=none',
    );
  }

  return args;
}

/**
 * Arguments for DevTools debugging.
 */
export function getDevToolsArgs(): string[] {
  return ['--auto-open-devtools-for-tabs'];
}

export interface BuildBrowserArgsOptions {
  headless?: boolean;
  devtools?: boolean;
  additionalArgs?: string[];
  noSandbox?: boolean;
}

/**
 * Get arguments to disable Chrome sandboxes.
 */
export function getNoSandboxArgs(): string[] {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
  ];
}

/**
 * Build complete browser arguments based on options.
 */
export function buildBrowserArgs(
  options: BuildBrowserArgsOptions,
): string[] {
  const args = [...getDefaultBrowserArgs()];

  if (options.headless) {
    args.push(...getHeadlessBrowserArgs());
  }

  if (options.noSandbox && !options.headless) {
    args.push(...getNoSandboxArgs());
  }

  if (options.devtools) {
    args.push(...getDevToolsArgs());
  }

  if (options.additionalArgs) {
    args.push(...options.additionalArgs);
  }

  return args;
}

// ============================================================================
// Browser Configuration Types
// ============================================================================

export type BrowserConfig =
  | {connectionType: 'default'}
  | {connectionType: 'executable'; executablePath: string}
  | {connectionType: 'cdp'; cdpUrl: string}
  | {connectionType: 'self'};

// ============================================================================
// Temp File Management for Large Snapshots
// ============================================================================

/** Directory for temporary log files */
const TEMP_LOG_DIR = path.join(os.homedir(), '.rc-devtools-mcp', 'browser-logs');

/** Default snapshot size threshold (200KB) */
const SNAPSHOT_SIZE_THRESHOLD = 200 * 1024;

/** Number of preview lines for large snapshots */
const SNAPSHOT_PREVIEW_LINES = 50;

export interface SnapshotFileInfo {
  filePath: string;
  previewLines: string[];
  totalLines: number;
}

/**
 * Writes a large snapshot to a file and returns a preview with file reference.
 */
export async function writeSnapshotToFile(
  snapshot: string,
): Promise<SnapshotFileInfo> {
  await fs.promises.mkdir(TEMP_LOG_DIR, {recursive: true});
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `snapshot-${timestamp}.log`;
  const filePath = path.join(TEMP_LOG_DIR, fileName);
  const lines = snapshot.split('\n');
  const totalLines = lines.length;
  const previewLines = lines.slice(
    0,
    Math.min(SNAPSHOT_PREVIEW_LINES, totalLines),
  );

  await fs.promises.writeFile(filePath, snapshot, 'utf8');
  logger(
    `Large snapshot written to: ${filePath} (${totalLines} lines, ${previewLines.length} preview lines)`,
  );

  return {filePath, previewLines, totalLines};
}

/**
 * Clean up old log files from the temporary directory.
 */
export async function cleanupOldLogFiles(): Promise<void> {
  try {
    const dirExists = await fs.promises
      .access(TEMP_LOG_DIR)
      .then(() => true)
      .catch(() => false);

    if (!dirExists) {
      return;
    }

    const files = await fs.promises.readdir(TEMP_LOG_DIR);
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

    for (const file of files) {
      if (file.endsWith('.log')) {
        const filePath = path.join(TEMP_LOG_DIR, file);
        try {
          const stats = await fs.promises.stat(filePath);
          if (now - stats.mtimeMs > maxAge) {
            await fs.promises.unlink(filePath);
            logger(`Cleaned up old log file: ${file}`);
          }
        } catch (error) {
          logger(`Failed to clean up log file ${file}: ${error}`);
        }
      }
    }
  } catch (error) {
    logger(`Failed to cleanup old log files: ${error}`);
  }
}

/**
 * Check if a snapshot exceeds the size threshold.
 */
export function isSnapshotTooLarge(
  snapshot: string,
  threshold = SNAPSHOT_SIZE_THRESHOLD,
): boolean {
  return Buffer.byteLength(snapshot, 'utf8') > threshold;
}

/**
 * Get the temp log directory path.
 */
export function getTempLogDir(): string {
  return TEMP_LOG_DIR;
}

// ============================================================================
// Browser Status Checking
// ============================================================================

/**
 * Check and return the current browser/Chromium status.
 */
export async function checkBrowserStatus(): Promise<{
  platform: string;
  chromeFound: boolean;
  chromePath: string;
  nodeVersion: string;
}> {
  const chromePath = await getChromeExecutablePath();
  return {
    platform: os.platform(),
    chromeFound: !!chromePath,
    chromePath: chromePath || 'bundled',
    nodeVersion: process.version,
  };
}


// ============================================================================
// Native Chrome Launch with CDP (Reduced Detection Mode)
// ============================================================================

export interface NativeChromeOptions {
  /** CDP port number (default: 9222) */
  cdpPort?: number;
  /** User data directory for Chrome profile */
  userDataDir?: string;
  /** Run in headless mode */
  headless?: boolean;
  /** Additional Chrome arguments */
  additionalArgs?: string[];
  /** Open DevTools automatically */
  devtools?: boolean;
  /** Proxy server URL */
  proxyServer?: string;
  /** Disable Chrome sandboxes (required for Docker/server environments) */
  noSandbox?: boolean;
}

export interface NativeChromeInstance {
  /** Chrome process */
  process: ChildProcess;
  /** CDP URL to connect */
  cdpUrl: string;
  /** WebSocket URL for browser connection */
  wsUrl: string;
  /** Kill the Chrome process */
  kill: () => void;
}

// Store the launched Chrome process for cleanup
let nativeChromeProcess: ChildProcess | null = null;

/**
 * Launch Chrome natively with CDP enabled.
 * This method avoids automation flags, reducing detection risk.
 *
 * @param options - Launch options
 * @returns Native Chrome instance with CDP connection info
 */
export async function launchNativeChrome(
  options: NativeChromeOptions = {},
): Promise<NativeChromeInstance> {
  const {
    cdpPort = 9222,
    userDataDir,
    headless = false,
    additionalArgs = [],
    devtools = false,
    proxyServer,
    noSandbox = false,
  } = options;

  // Find Chrome executable
  const chromePath = await getChromeExecutablePath();
  if (!chromePath) {
    throw new Error(
      'Chrome executable not found. Please install Chrome or specify executablePath.',
    );
  }

  // Build Chrome arguments - minimal flags to reduce detection
  const args: string[] = [
    `--remote-debugging-port=${cdpPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--hide-crash-restore-bubble',
  ];

  // Use custom user data dir (required for remote debugging)
  const effectiveUserDataDir =
    userDataDir ||
    path.join(os.homedir(), '.cache', 'rc-devtools-mcp', 'native-profile');
  await fs.promises.mkdir(effectiveUserDataDir, {recursive: true});
  args.push(`--user-data-dir=${effectiveUserDataDir}`);

  // Headless mode
  if (headless) {
    args.push('--headless=new');
    args.push('--disable-gpu');
    args.push('--disable-software-rasterizer');

    if (os.platform() === 'linux') {
      args.push(
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-zygote',
        '--font-render-hinting=none',
      );
    }
  }

  // Add no-sandbox args if explicitly requested (for non-headless scenarios)
  if (noSandbox && !headless) {
    args.push(
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    );
  }

  // DevTools
  if (devtools) {
    args.push('--auto-open-devtools-for-tabs');
  }

  // Proxy server
  if (proxyServer) {
    args.push(`--proxy-server=${proxyServer}`);
  }

  // Additional args
  args.push(...additionalArgs);

  logger(`Launching native Chrome: ${chromePath}`);
  logger(`Chrome args: ${args.join(' ')}`);

  // Spawn Chrome process
  const chromeProcess = spawn(chromePath, args, {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  nativeChromeProcess = chromeProcess;

  // Handle process errors
  chromeProcess.on('error', err => {
    logger(`Chrome process error: ${err.message}`);
  });

  chromeProcess.stderr?.on('data', data => {
    const msg = data.toString();
    if (
      msg.includes('DevTools listening') ||
      msg.includes('ERROR') ||
      msg.includes('FATAL')
    ) {
      logger(`Chrome stderr: ${msg}`);
    }
  });

  // Wait for CDP to be available
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  let wsUrl = '';

  const maxAttempts = 30; // 15 seconds max
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      wsUrl = await getSelfCdpUrl(cdpPort);
      logger(`Chrome CDP ready at ${cdpUrl}, WebSocket: ${wsUrl}`);
      break;
    } catch {
      if (attempt === maxAttempts - 1) {
        chromeProcess.kill();
        throw new Error(
          `Failed to get CDP URL after ${maxAttempts} attempts. Chrome may have failed to start.`,
        );
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  // Setup cleanup on process exit
  const cleanup = () => {
    if (nativeChromeProcess === chromeProcess) {
      nativeChromeProcess = null;
    }
  };

  chromeProcess.on('exit', cleanup);
  chromeProcess.on('close', cleanup);

  return {
    process: chromeProcess,
    cdpUrl,
    wsUrl,
    kill: () => {
      try {
        chromeProcess.kill('SIGTERM');
        logger('Native Chrome process terminated');
      } catch (err) {
        logger(`Error killing Chrome: ${err}`);
      }
    },
  };
}

/**
 * Check if a native Chrome instance is running on the specified port.
 */
export async function isNativeChromeRunning(port = 9222): Promise<boolean> {
  try {
    await getSelfCdpUrl(port);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill any running native Chrome instance.
 */
export function killNativeChrome(): void {
  if (nativeChromeProcess) {
    try {
      nativeChromeProcess.kill('SIGTERM');
      logger('Native Chrome process killed');
    } catch (err) {
      logger(`Error killing native Chrome: ${err}`);
    }
    nativeChromeProcess = null;
  }
}

/**
 * Get the currently running native Chrome process.
 */
export function getNativeChromeProcess(): ChildProcess | null {
  return nativeChromeProcess;
}
