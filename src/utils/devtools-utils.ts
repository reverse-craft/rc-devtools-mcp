/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

import {PuppeteerDevToolsConnection} from '../core/devtools-connection-adapter.js';
import {ISSUE_UTILS} from '../issue-descriptions.js';
import {logger} from './logger.js';
import {Mutex} from './mutex.js';
import {DevTools} from '../third-party/index.js';
import type {
  Browser,
  Page,
  Target as PuppeteerTarget,
} from '../third-party/index.js';

export function extractUrlLikeFromDevToolsTitle(
  title: string,
): string | undefined {
  const match = title.match(new RegExp(`DevTools - (.*)`));
  return match?.[1] ?? undefined;
}

export function urlsEqual(url1: string, url2: string): boolean {
  const normalizedUrl1 = normalizeUrl(url1);
  const normalizedUrl2 = normalizeUrl(url2);
  return normalizedUrl1 === normalizedUrl2;
}

/**
 * Normalize a URL for comparison purposes.
 * Removes protocol, www prefix, trailing slashes, and hash fragments.
 */
function normalizeUrl(url: string): string {
  let result = url.trim();

  // Remove protocols
  if (result.startsWith('https://')) {
    result = result.slice(8);
  } else if (result.startsWith('http://')) {
    result = result.slice(7);
  }

  // Remove 'www.'. This ensures that we find the right URL regardless of if the user adds `www` or not.
  if (result.startsWith('www.')) {
    result = result.slice(4);
  }

  // We use target URLs to locate DevTools but those often do
  // no include hash.
  const hashIdx = result.lastIndexOf('#');
  if (hashIdx !== -1) {
    result = result.slice(0, hashIdx);
  }

  // Remove trailing slash
  if (result.endsWith('/')) {
    result = result.slice(0, -1);
  }

  return result;
}

/**
 * A mock implementation of an issues manager that only implements the methods
 * that are actually used by the IssuesAggregator
 */
export class FakeIssuesManager extends DevTools.Common.ObjectWrapper
  .ObjectWrapper<DevTools.IssuesManagerEventTypes> {
  issues(): DevTools.Issue[] {
    return [];
  }
}

export function mapIssueToMessageObject(issue: DevTools.AggregatedIssue) {
  const count = issue.getAggregatedIssuesCount();
  const markdownDescription = issue.getDescription();
  const filename = markdownDescription?.file;
  if (!markdownDescription) {
    logger(`no description found for issue:` + issue.code);
    return null;
  }
  const rawMarkdown = filename
    ? ISSUE_UTILS.getIssueDescription(filename)
    : null;
  if (!rawMarkdown) {
    logger(`no markdown ${filename} found for issue:` + issue.code);
    return null;
  }
  let processedMarkdown: string;
  let title: string | null;

  try {
    processedMarkdown =
      DevTools.MarkdownIssueDescription.substitutePlaceholders(
        rawMarkdown,
        markdownDescription.substitutions,
      );
    const markdownAst = DevTools.Marked.Marked.lexer(processedMarkdown);
    title =
      DevTools.MarkdownIssueDescription.findTitleFromMarkdownAst(markdownAst);
  } catch {
    logger('error parsing markdown for issue ' + issue.code());
    return null;
  }
  if (!title) {
    logger('cannot read issue title from ' + filename);
    return null;
  }
  return {
    type: 'issue',
    item: issue,
    message: title,
    count,
    description: processedMarkdown,
  };
}

// DevTools CDP errors can get noisy.
DevTools.ProtocolClient.InspectorBackend.test.suppressRequestErrors = true;

DevTools.I18n.DevToolsLocale.DevToolsLocale.instance({
  create: true,
  data: {
    navigatorLanguage: 'en-US',
    settingLanguage: 'en-US',
    lookupClosestDevToolsLocale: l => l,
  },
});
DevTools.I18n.i18n.registerLocaleDataForTest('en-US', {});

export interface TargetUniverse {
  /** The DevTools target corresponding to the puppeteer Page */
  target: DevTools.SDKTarget;
  universe: DevTools.Foundation.Universe.Universe;
}
export type TargetUniverseFactoryFn = (page: Page) => Promise<TargetUniverse>;

export class UniverseManager {
  readonly #browser: Browser;
  readonly #createUniverseFor: TargetUniverseFactoryFn;
  readonly #universes = new WeakMap<Page, TargetUniverse>();

  /** Guard access to #universes so we don't create unnecessary universes */
  readonly #mutex = new Mutex();

  constructor(
    browser: Browser,
    factory: TargetUniverseFactoryFn = DEFAULT_FACTORY,
  ) {
    this.#browser = browser;
    this.#createUniverseFor = factory;
  }

  async init(pages: Page[]) {
    try {
      await this.#mutex.acquire();
      const promises = [];
      for (const page of pages) {
        promises.push(
          this.#createUniverseFor(page).then(targetUniverse =>
            this.#universes.set(page, targetUniverse),
          ),
        );
      }

      this.#browser.on('targetcreated', this.#onTargetCreated);
      this.#browser.on('targetdestroyed', this.#onTargetDestroyed);

      await Promise.all(promises);
    } finally {
      this.#mutex.release();
    }
  }

  get(page: Page): TargetUniverse | null {
    return this.#universes.get(page) ?? null;
  }

  dispose() {
    this.#browser.off('targetcreated', this.#onTargetCreated);
    this.#browser.off('targetdestroyed', this.#onTargetDestroyed);
  }

  #onTargetCreated = async (target: PuppeteerTarget) => {
    const page = await target.page();
    try {
      await this.#mutex.acquire();
      if (!page || this.#universes.has(page)) {
        return;
      }

      this.#universes.set(page, await this.#createUniverseFor(page));
    } finally {
      this.#mutex.release();
    }
  };

  #onTargetDestroyed = async (target: PuppeteerTarget) => {
    const page = await target.page();
    try {
      await this.#mutex.acquire();
      if (!page || !this.#universes.has(page)) {
        return;
      }
      this.#universes.delete(page);
    } finally {
      this.#mutex.release();
    }
  };
}

const DEFAULT_FACTORY: TargetUniverseFactoryFn = async (page: Page) => {
  const settingStorage = new DevTools.Common.Settings.SettingsStorage({});
  const universe = new DevTools.Foundation.Universe.Universe({
    settingsCreationOptions: {
      syncedStorage: settingStorage,
      globalStorage: settingStorage,
      localStorage: settingStorage,
      settingRegistrations:
        DevTools.Common.SettingRegistration.getRegisteredSettings(),
    },
    overrideAutoStartModels: new Set([DevTools.DebuggerModel]),
  });

  const session = await page.createCDPSession();
  const connection = new PuppeteerDevToolsConnection(session);

  const targetManager = universe.context.get(DevTools.TargetManager);
  targetManager.observeModels(DevTools.DebuggerModel, SKIP_ALL_PAUSES);

  const target = targetManager.createTarget(
    'main',
    '',
    'frame' as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    /* parentTarget */ null,
    session.id(),
    undefined,
    connection,
  );
  return {target, universe};
};

// We don't want to pause any DevTools universe session ever on the MCP side.
//
// Note that calling `setSkipAllPauses` only affects the session on which it was
// sent. This means DevTools can still pause, step and do whatever. We just won't
// see the `Debugger.paused`/`Debugger.resumed` events on the MCP side.
const SKIP_ALL_PAUSES = {
  modelAdded(model: DevTools.DebuggerModel): void {
    void model.agent.invoke_setSkipAllPauses({skip: true});
  },

  modelRemoved(): void {
    // Do nothing.
  },
};
