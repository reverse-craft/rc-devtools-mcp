/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP Context for rc-devtools-mcp.
 * Provides the execution context for MCP tools including page management,
 * network request collection, and console message handling.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {launch, type McpLaunchOptions} from './browser.js';
import {extractUrlLikeFromDevToolsTitle, urlsEqual} from '../utils/devtools-utils.js';
import type {ListenerMap} from './page-collector.js';
import {NetworkCollector, ConsoleCollector} from './page-collector.js';
import {Locator} from '../third-party/index.js';
import type {DevTools} from '../third-party/index.js';
import type {
  Browser,
  ConsoleMessage,
  Debugger,
  Dialog,
  ElementHandle,
  HTTPRequest,
  Page,
  SerializedAXNode,
  PredefinedNetworkConditions,
} from '../third-party/index.js';
import {listPages} from '../tools/pages.js';
import {takeSnapshot} from '../tools/snapshot.js';
import {maybeInitializeVmasmForPage} from '../tools/vmasm.js';
import {CLOSE_PAGE_ERROR} from '../tools/tool-definition.js';
import type {Context, DevToolsData} from '../tools/tool-definition.js';
import {disposeCdpSession, getNetworkInitiator, isDebuggerPaused, hasCdpSession, type NetworkInitiator} from '../utils/cdp.js';
import {initializeDebuggerForPage} from '../utils/debugger-utils.js';
import {WaitForHelper} from '../utils/wait-for-helper.js';

export interface TextSnapshotNode extends SerializedAXNode {
  id: string;
  backendNodeId?: number;
  children: TextSnapshotNode[];
}

export interface GeolocationOptions {
  latitude: number;
  longitude: number;
}

export interface TextSnapshot {
  root: TextSnapshotNode;
  idToNode: Map<string, TextSnapshotNode>;
  snapshotId: string;
  selectedElementUid?: string;
  hasSelectedElement: boolean;
  verbose: boolean;
}

interface McpContextOptions {
  experimentalDevToolsDebugging: boolean;
  experimentalIncludeAllPages?: boolean;
  proxyAuth?: {
    username: string;
    password: string;
  };
  launchOptions?: McpLaunchOptions;
}

const DEFAULT_TIMEOUT = 5_000;
const NAVIGATION_TIMEOUT = 10_000;

function getNetworkMultiplierFromString(condition: string | null): number {
  const puppeteerCondition =
    condition as keyof typeof PredefinedNetworkConditions;

  switch (puppeteerCondition) {
    case 'Fast 4G':
      return 1;
    case 'Slow 4G':
      return 2.5;
    case 'Fast 3G':
      return 5;
    case 'Slow 3G':
      return 10;
  }
  return 1;
}

function getExtensionFromMimeType(mimeType: string) {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpeg';
    case 'image/webp':
      return 'webp';
  }
  throw new Error(`No mapping for Mime type ${mimeType}.`);
}


export class McpContext implements Context {
  browser: Browser;
  logger: Debugger;

  #browsers = new Set<Browser>();
  #pages: Page[] = [];
  #pageToDevToolsPage = new Map<Page, Page>();
  #selectedPage?: Page;
  #textSnapshot: TextSnapshot | null = null;
  #networkCollector: NetworkCollector;
  #consoleCollector: ConsoleCollector;

  #networkConditionsMap = new WeakMap<Page, string>();
  #cpuThrottlingRateMap = new WeakMap<Page, number>();
  #geolocationMap = new WeakMap<Page, GeolocationOptions>();
  #dialog?: Dialog;

  #nextSnapshotId = 1;

  #locatorClass: typeof Locator;
  #options: McpContextOptions;

  private constructor(
    browser: Browser,
    logger: Debugger,
    options: McpContextOptions,
    locatorClass: typeof Locator,
  ) {
    this.browser = browser;
    this.#browsers.add(browser);
    this.logger = logger;
    this.#locatorClass = locatorClass;
    this.#options = options;

    this.#networkCollector = new NetworkCollector(this.browser);

    this.#consoleCollector = new ConsoleCollector(this.browser, collect => {
      return {
        console: event => {
          collect(event);
        },
        pageerror: event => {
          if (event instanceof Error) {
            collect(event);
          } else {
            const error = new Error(`${event}`);
            error.stack = undefined;
            collect(error);
          }
        },
        issue: event => {
          collect(event);
        },
      } as ListenerMap;
    });
  }

  async #init() {
    const pages = await this.createPagesSnapshot();
    
    for (const page of pages) {
      if (this.#options.proxyAuth) {
        await this.#applyProxyAuth(page);
      }
      await initializeDebuggerForPage(page).catch(error => {
        this.logger('Error enabling debugger for existing page during init', error);
      });
      // Initialize VMASM interception if configured
      await maybeInitializeVmasmForPage(page).catch(error => {
        this.logger('Error initializing vmasm for existing page during init', error);
      });
    }
    
    await this.#networkCollector.init(pages);
    await this.#consoleCollector.init(pages);

    this.browser.on('targetcreated', this.#onTargetCreated);
  }

  #onTargetCreated = async (target: any) => {
    try {
      const page = await target.page();
      if (!page) {
        return;
      }
      await initializeDebuggerForPage(page).catch(error => {
        this.logger('Error enabling debugger for externally created page', error);
      });
      // Initialize VMASM interception if configured
      await maybeInitializeVmasmForPage(page).catch(error => {
        this.logger('Error initializing vmasm for externally created page', error);
      });
    } catch (err) {
      this.logger('Error handling targetcreated event', err);
    }
  };

  async #applyProxyAuth(page: Page): Promise<void> {
    if (this.#options.proxyAuth) {
      await page.authenticate({
        username: this.#options.proxyAuth.username,
        password: this.#options.proxyAuth.password,
      });
    }
  }

  dispose() {
    this.#networkCollector.dispose();
    this.#consoleCollector.dispose();
    for (const browser of this.#browsers) {
      browser.off('targetcreated', this.#onTargetCreated);
    }
    for (const page of this.#pages) {
      void disposeCdpSession(page);
    }
  }

  static async from(
    browser: Browser,
    logger: Debugger,
    opts: McpContextOptions,
    locatorClass: typeof Locator = Locator,
  ) {
    const context = new McpContext(browser, logger, opts, locatorClass);
    await context.#init();
    return context;
  }

  resolveCdpRequestId(cdpRequestId: string): number | undefined {
    const selectedPage = this.getSelectedPage();
    if (!cdpRequestId) {
      this.logger('no network request');
      return;
    }
    const request = this.#networkCollector.find(selectedPage, request => {
      // @ts-expect-error id is internal.
      return request.id === cdpRequestId;
    });
    if (!request) {
      this.logger('no network request for ' + cdpRequestId);
      return;
    }
    return this.#networkCollector.getIdForResource(request);
  }

  resolveCdpElementId(cdpBackendNodeId: number): string | undefined {
    if (!cdpBackendNodeId) {
      this.logger('no cdpBackendNodeId');
      return;
    }
    if (this.#textSnapshot === null) {
      this.logger('no text snapshot');
      return;
    }
    const queue = [this.#textSnapshot.root];
    while (queue.length) {
      const current = queue.pop()!;
      if (current.backendNodeId === cdpBackendNodeId) {
        return current.id;
      }
      for (const child of current.children) {
        queue.push(child);
      }
    }
    return;
  }

  getNetworkRequests(includePreservedRequests?: boolean): HTTPRequest[] {
    const page = this.getSelectedPage();
    return this.#networkCollector.getData(page, includePreservedRequests);
  }

  getConsoleData(
    includePreservedMessages?: boolean,
  ): Array<ConsoleMessage | Error | DevTools.AggregatedIssue> {
    const page = this.getSelectedPage();
    return this.#consoleCollector.getData(page, includePreservedMessages);
  }

  getConsoleMessageStableId(
    message: ConsoleMessage | Error | DevTools.AggregatedIssue,
  ): number {
    return this.#consoleCollector.getIdForResource(message);
  }

  getConsoleMessageById(
    id: number,
  ): ConsoleMessage | Error | DevTools.AggregatedIssue {
    return this.#consoleCollector.getById(this.getSelectedPage(), id);
  }

  async newPage(options?: {
    incognito?: boolean;
    userDataDir?: string;
    newWindow?: boolean;
    enableDebugger?: boolean;
  }): Promise<Page> {
    let page: Page;
    if (options?.userDataDir) {
      if (!this.#options.launchOptions) {
        throw new Error(
          'Launch options are required to start a new browser instance with userDataDir',
        );
      }
      const newBrowser = await launch({
        ...this.#options.launchOptions,
        userDataDir: options.userDataDir,
        isolated: true,
      });
      this.#browsers.add(newBrowser);
      this.#networkCollector.addBrowser(newBrowser);
      this.#consoleCollector.addBrowser(newBrowser);
      newBrowser.on('targetcreated', this.#onTargetCreated);
      const pages = await newBrowser.pages();
      page = pages[0] || (await newBrowser.newPage());
    } else if (options?.incognito || options?.newWindow) {
      const browserContext = await this.browser.createBrowserContext();
      page = await browserContext.newPage();
    } else {
      page = await this.browser.newPage();
    }

    await this.#applyProxyAuth(page);
    if (options?.enableDebugger !== false) {
      await initializeDebuggerForPage(page).catch(error => {
        this.logger('Error enabling debugger for new page', error);
      });
    }
    // Initialize VMASM interception if configured
    await maybeInitializeVmasmForPage(page).catch(error => {
      this.logger('Error initializing vmasm for new page', error);
    });
    await this.createPagesSnapshot();
    this.selectPage(page);
    this.#networkCollector.addPage(page);
    this.#consoleCollector.addPage(page);
    return page;
  }

  async closePage(pageIdx: number): Promise<void> {
    if (this.#pages.length === 1) {
      throw new Error(CLOSE_PAGE_ERROR);
    }
    const page = this.getPageByIdx(pageIdx);
    await disposeCdpSession(page);
    await page.close({runBeforeUnload: false});
  }

  getNetworkRequestById(reqid: number): HTTPRequest {
    return this.#networkCollector.getById(this.getSelectedPage(), reqid);
  }

  setNetworkConditions(conditions: string | null): void {
    const page = this.getSelectedPage();
    if (conditions === null) {
      this.#networkConditionsMap.delete(page);
    } else {
      this.#networkConditionsMap.set(page, conditions);
    }
    this.#updateSelectedPageTimeouts();
  }

  getNetworkConditions(): string | null {
    const page = this.getSelectedPage();
    return this.#networkConditionsMap.get(page) ?? null;
  }

  setCpuThrottlingRate(rate: number): void {
    const page = this.getSelectedPage();
    this.#cpuThrottlingRateMap.set(page, rate);
    this.#updateSelectedPageTimeouts();
  }

  getCpuThrottlingRate(): number {
    const page = this.getSelectedPage();
    return this.#cpuThrottlingRateMap.get(page) ?? 1;
  }

  setGeolocation(geolocation: GeolocationOptions | null): void {
    const page = this.getSelectedPage();
    if (geolocation === null) {
      this.#geolocationMap.delete(page);
    } else {
      this.#geolocationMap.set(page, geolocation);
    }
  }

  getGeolocation(): GeolocationOptions | null {
    const page = this.getSelectedPage();
    return this.#geolocationMap.get(page) ?? null;
  }

  getDialog(): Dialog | undefined {
    return this.#dialog;
  }

  clearDialog(): void {
    this.#dialog = undefined;
  }

  getSelectedPage(): Page {
    const page = this.#selectedPage;
    if (!page) {
      throw new Error('No page selected');
    }
    if (page.isClosed()) {
      throw new Error(
        `The selected page has been closed. Call ${listPages.name} to see open pages.`,
      );
    }
    return page;
  }

  getPageByIdx(idx: number): Page {
    const pages = this.#pages;
    const page = pages[idx];
    if (!page) {
      throw new Error('No page found');
    }
    return page;
  }

  #dialogHandler = (dialog: Dialog): void => {
    this.#dialog = dialog;
  };

  isPageSelected(page: Page): boolean {
    return this.#selectedPage === page;
  }

  selectPage(newPage: Page): void {
    const oldPage = this.#selectedPage;
    if (oldPage) {
      oldPage.off('dialog', this.#dialogHandler);
      void oldPage.emulateFocusedPage(false).catch(error => {
        this.logger('Error turning off focused page emulation', error);
      });
    }
    this.#selectedPage = newPage;
    newPage.on('dialog', this.#dialogHandler);
    this.#updateSelectedPageTimeouts();
    void newPage.emulateFocusedPage(true).catch(error => {
      this.logger('Error turning on focused page emulation', error);
    });
    void initializeDebuggerForPage(newPage).catch(error => {
      this.logger('Error initializing debugger for page', error);
    });
    // Initialize VMASM interception if configured
    void maybeInitializeVmasmForPage(newPage).catch(error => {
      this.logger('Error initializing vmasm for selected page', error);
    });
  }

  #updateSelectedPageTimeouts() {
    const page = this.getSelectedPage();
    const cpuMultiplier = this.getCpuThrottlingRate();
    page.setDefaultTimeout(DEFAULT_TIMEOUT * cpuMultiplier);
    const networkMultiplier = getNetworkMultiplierFromString(
      this.getNetworkConditions(),
    );
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT * networkMultiplier);
  }

  getNavigationTimeout() {
    const page = this.getSelectedPage();
    return page.getDefaultNavigationTimeout();
  }

  getAXNodeByUid(uid: string) {
    return this.#textSnapshot?.idToNode.get(uid);
  }

  async getElementByUid(uid: string): Promise<ElementHandle<Element>> {
    if (!this.#textSnapshot?.idToNode.size) {
      throw new Error(
        `No snapshot found. Use ${takeSnapshot.name} to capture one.`,
      );
    }
    const [snapshotId] = uid.split('_');

    if (this.#textSnapshot.snapshotId !== snapshotId) {
      throw new Error(
        'This uid is coming from a stale snapshot. Call take_snapshot to get a fresh snapshot.',
      );
    }

    const node = this.#textSnapshot?.idToNode.get(uid);
    if (!node) {
      throw new Error('No such element found in the snapshot');
    }
    const handle = await node.elementHandle();
    if (!handle) {
      throw new Error('No such element found in the snapshot');
    }
    return handle;
  }

  async createPagesSnapshot(): Promise<Page[]> {
    const allPages: Page[] = [];
    for (const browser of this.#browsers) {
      const browserPages = await browser.pages(
        this.#options.experimentalIncludeAllPages,
      );
      allPages.push(...browserPages);
    }

    this.#pages = allPages.filter(page => {
      return (
        this.#options.experimentalDevToolsDebugging ||
        !page.url().startsWith('devtools://')
      );
    });

    if (
      (!this.#selectedPage || this.#pages.indexOf(this.#selectedPage) === -1) &&
      this.#pages[0]
    ) {
      this.selectPage(this.#pages[0]);
    }

    await this.detectOpenDevToolsWindows();

    return this.#pages;
  }

  async detectOpenDevToolsWindows() {
    this.logger('Detecting open DevTools windows');
    const allPages: Page[] = [];
    for (const browser of this.#browsers) {
      const browserPages = await browser.pages(
        this.#options.experimentalIncludeAllPages,
      );
      allPages.push(...browserPages);
    }

    this.#pageToDevToolsPage = new Map<Page, Page>();
    for (const devToolsPage of allPages) {
      if (devToolsPage.url().startsWith('devtools://')) {
        try {
          this.logger('Calling getTargetInfo for ' + devToolsPage.url());
          const data = await devToolsPage
            // @ts-expect-error no types for _client().
            ._client()
            .send('Target.getTargetInfo');
          const devtoolsPageTitle = data.targetInfo.title;
          const urlLike = extractUrlLikeFromDevToolsTitle(devtoolsPageTitle);
          if (!urlLike) {
            continue;
          }
          for (const page of this.#pages) {
            if (urlsEqual(page.url(), urlLike)) {
              this.#pageToDevToolsPage.set(page, devToolsPage);
            }
          }
        } catch (error) {
          this.logger('Issue occurred while trying to find DevTools', error);
        }
      }
    }
  }

  getPages(): Page[] {
    return this.#pages;
  }

  getDevToolsPage(page: Page): Page | undefined {
    return this.#pageToDevToolsPage.get(page);
  }

  async getDevToolsData(): Promise<DevToolsData> {
    try {
      this.logger('Getting DevTools UI data');
      const selectedPage = this.getSelectedPage();
      
      // Check if debugger is paused - if so, skip to avoid hanging
      // Only check if CDP session exists (debugger might be enabled)
      if (hasCdpSession(selectedPage) && isDebuggerPaused(selectedPage)) {
        this.logger('Debugger is paused, skipping DevTools data retrieval');
        return {};
      }
      
      const devtoolsPage = this.getDevToolsPage(selectedPage);
      if (!devtoolsPage) {
        this.logger('No DevTools page detected');
        return {};
      }
      
      // Add timeout protection
      const DEVTOOLS_EVAL_TIMEOUT = 3000;
      const evalPromise = devtoolsPage.evaluate(
        async () => {
          // @ts-expect-error no types
          const UI = await import('/bundled/ui/legacy/legacy.js');
          // @ts-expect-error no types
          const SDK = await import('/bundled/core/sdk/sdk.js');
          const request = UI.Context.Context.instance().flavor(
            SDK.NetworkRequest.NetworkRequest,
          );
          const node = UI.Context.Context.instance().flavor(
            SDK.DOMModel.DOMNode,
          );
          return {
            cdpRequestId: request?.requestId(),
            cdpBackendNodeId: node?.backendNodeId(),
          };
        },
      );
      
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('DevTools evaluation timeout')), DEVTOOLS_EVAL_TIMEOUT);
      });
      
      const {cdpRequestId, cdpBackendNodeId} = await Promise.race([evalPromise, timeoutPromise]);
      return {cdpBackendNodeId, cdpRequestId};
    } catch (err) {
      this.logger('error getting devtools data', err);
    }
    return {};
  }

  async createTextSnapshot(
    verbose = false,
    devtoolsData: DevToolsData | undefined = undefined,
  ): Promise<void> {
    const page = this.getSelectedPage();
    const rootNode = await page.accessibility.snapshot({
      includeIframes: true,
      interestingOnly: !verbose,
    });
    if (!rootNode) {
      return;
    }

    const snapshotId = this.#nextSnapshotId++;
    let idCounter = 0;
    const idToNode = new Map<string, TextSnapshotNode>();
    const assignIds = (node: SerializedAXNode): TextSnapshotNode => {
      const nodeWithId: TextSnapshotNode = {
        ...node,
        id: `${snapshotId}_${idCounter++}`,
        children: node.children
          ? node.children.map(child => assignIds(child))
          : [],
      };

      if (node.role === 'option') {
        const optionText = node.name;
        if (optionText) {
          nodeWithId.value = optionText.toString();
        }
      }

      idToNode.set(nodeWithId.id, nodeWithId);
      return nodeWithId;
    };

    const rootNodeWithId = assignIds(rootNode);
    this.#textSnapshot = {
      root: rootNodeWithId,
      snapshotId: String(snapshotId),
      idToNode,
      hasSelectedElement: false,
      verbose,
    };
    const data = devtoolsData ?? (await this.getDevToolsData());
    if (data?.cdpBackendNodeId) {
      this.#textSnapshot.hasSelectedElement = true;
      this.#textSnapshot.selectedElementUid = this.resolveCdpElementId(
        data?.cdpBackendNodeId,
      );
    }
  }

  getTextSnapshot(): TextSnapshot | null {
    return this.#textSnapshot;
  }

  async saveTemporaryFile(
    data: Uint8Array<ArrayBufferLike>,
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp',
  ): Promise<{filename: string}> {
    try {
      const dir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'rc-devtools-mcp-'),
      );

      const filename = path.join(
        dir,
        `screenshot.${getExtensionFromMimeType(mimeType)}`,
      );
      await fs.writeFile(filename, data);
      return {filename};
    } catch (err) {
      this.logger(err);
      throw new Error('Could not save a screenshot to a file', {cause: err});
    }
  }

  async saveFile(
    data: Uint8Array<ArrayBufferLike>,
    filename: string,
  ): Promise<{filename: string}> {
    try {
      const filePath = path.isAbsolute(filename)
        ? filename
        : path.join(process.cwd(), filename);
      this.logger(`saveFile: cwd=${process.cwd()}, filename=${filename}, resolved=${filePath}`);
      await fs.mkdir(path.dirname(filePath), {recursive: true});
      await fs.writeFile(filePath, data);
      return {filename: filePath};
    } catch (err) {
      this.logger(`saveFile error: ${err}`);
      throw new Error(`Could not save to file ${filename}`, {cause: err});
    }
  }

  getWaitForHelper(
    page: Page,
    cpuMultiplier: number,
    networkMultiplier: number,
  ) {
    return new WaitForHelper(page, cpuMultiplier, networkMultiplier);
  }

  waitForEventsAfterAction(action: () => Promise<unknown>): Promise<void> {
    const page = this.getSelectedPage();
    const cpuMultiplier = this.getCpuThrottlingRate();
    const networkMultiplier = getNetworkMultiplierFromString(
      this.getNetworkConditions(),
    );
    const waitForHelper = this.getWaitForHelper(
      page,
      cpuMultiplier,
      networkMultiplier,
    );
    return waitForHelper.waitForEventsAfterAction(action);
  }

  getNetworkRequestStableId(request: HTTPRequest): number {
    return this.#networkCollector.getIdForResource(request);
  }

  getNetworkRequestInitiator(reqid: number): NetworkInitiator | undefined {
    const page = this.getSelectedPage();
    const request = this.#networkCollector.getById(page, reqid);
    // @ts-expect-error id is internal
    const cdpRequestId = request.id as string;
    if (!cdpRequestId) {
      return undefined;
    }
    return getNetworkInitiator(page, cdpRequestId);
  }

  waitForTextOnPage(text: string, timeout?: number): Promise<Element> {
    const page = this.getSelectedPage();
    const frames = page.frames();

    let locator = this.#locatorClass.race(
      frames.flatMap(frame => [
        frame.locator(`aria/${text}`),
        frame.locator(`text/${text}`),
      ]),
    );

    if (timeout) {
      locator = locator.setTimeout(timeout);
    }

    return locator.wait();
  }

  async setUpNetworkCollectorForTesting() {
    this.#networkCollector = new NetworkCollector(this.browser, collect => {
      return {
        request: req => {
          if (req.url().includes('favicon.ico')) {
            return;
          }
          collect(req);
        },
      } as ListenerMap;
    });
    await this.#networkCollector.init(await this.browser.pages());
  }
}
