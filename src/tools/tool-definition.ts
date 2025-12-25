/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tool definition interfaces and utilities for rc-devtools-mcp.
 * Defines the structure for MCP tools including schemas, handlers, and context.
 */

import type {TextSnapshotNode, GeolocationOptions} from '../core/mcp-context.js';
import {zod} from '../third-party/index.js';
import type {Dialog, ElementHandle, HTTPRequest, Page} from '../third-party/index.js';
import type {NetworkInitiator} from '../utils/cdp.js';

export type NetworkRequestFilter = (request: HTTPRequest) => boolean;
import type {PaginationOptions} from '../utils/types.js';

import type {ToolCategory} from './categories.js';

export interface ToolDefinition<
  Schema extends zod.ZodRawShape = zod.ZodRawShape,
> {
  name: string;
  description: string;
  annotations: {
    title?: string;
    category: ToolCategory;
    /**
     * If true, the tool does not modify its environment.
     */
    readOnlyHint: boolean;
  };
  schema: Schema;
  handler: (
    request: Request<Schema>,
    response: Response,
    context: Context,
  ) => Promise<void>;
}

export interface Request<Schema extends zod.ZodRawShape> {
  params: zod.objectOutputType<Schema, zod.ZodTypeAny>;
}

export interface ImageContentData {
  data: string;
  mimeType: string;
}


export interface SnapshotParams {
  verbose?: boolean;
  filePath?: string;
  search?: string;
  pageSize?: number;
  pageIdx?: number;
}

export interface DevToolsData {
  cdpRequestId?: string;
  cdpBackendNodeId?: number;
}

export interface Response {
  appendResponseLine(value: string): void;
  setIncludePages(value: boolean): void;
  setIncludeNetworkRequests(
    value: boolean,
    options?: PaginationOptions & {
      resourceTypes?: string[];
      includePreservedRequests?: boolean;
      networkRequestIdInDevToolsUI?: number;
      filter?: NetworkRequestFilter;
    },
  ): void;
  setIncludeConsoleData(
    value: boolean,
    options?: PaginationOptions & {
      types?: string[];
      includePreservedMessages?: boolean;
      savePath?: string;
      maxLineLength?: number;
    },
  ): void;
  includeSnapshot(params?: SnapshotParams): void;
  attachImage(value: ImageContentData): void;
  attachNetworkRequest(reqid: number): void;
  attachConsoleMessage(msgid: number): void;
  // Allows re-using DevTools data queried by some tools.
  attachDevToolsData(data: DevToolsData): void;
}

/**
 * Context interface for tool execution.
 * Provides access to browser pages, network requests, and other resources.
 */
export type Context = Readonly<{
  getSelectedPage(): Page;
  getNetworkRequestById(reqid: number): HTTPRequest;
  /**
   * Returns all network requests for the current page.
   */
  getNetworkRequests(includePreserved?: boolean): HTTPRequest[];
  /**
   * Returns a stable id (reqid) for a network request.
   */
  getNetworkRequestStableId(request: HTTPRequest): number;
  getDialog(): Dialog | undefined;
  clearDialog(): void;
  getPageByIdx(idx: number): Page;
  isPageSelected(page: Page): boolean;
  newPage(options?: {
    incognito?: boolean;
    userDataDir?: string;
    newWindow?: boolean;
    enableDebugger?: boolean;
  }): Promise<Page>;
  closePage(pageIdx: number): Promise<void>;
  selectPage(page: Page): void;
  getElementByUid(uid: string): Promise<ElementHandle<Element>>;
  getAXNodeByUid(uid: string): TextSnapshotNode | undefined;
  setNetworkConditions(conditions: string | null): void;
  setCpuThrottlingRate(rate: number): void;
  setGeolocation(geolocation: GeolocationOptions | null): void;
  saveTemporaryFile(
    data: Uint8Array<ArrayBufferLike>,
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp',
  ): Promise<{filename: string}>;
  saveFile(
    data: Uint8Array<ArrayBufferLike>,
    filename: string,
  ): Promise<{filename: string}>;
  waitForEventsAfterAction(action: () => Promise<unknown>): Promise<void>;
  waitForTextOnPage(text: string, timeout?: number): Promise<Element>;
  getDevToolsData(): Promise<DevToolsData>;
  /**
   * Returns a reqid for a cdpRequestId.
   */
  resolveCdpRequestId(cdpRequestId: string): number | undefined;
  /**
   * Returns a reqid for a cdpRequestId.
   */
  resolveCdpElementId(cdpBackendNodeId: number): string | undefined;
  /**
   * Returns the initiator information for a network request.
   * This includes the call stack if the request was initiated by JavaScript.
   */
  getNetworkRequestInitiator(reqid: number): NetworkInitiator | undefined;
}>;

export function defineTool<Schema extends zod.ZodRawShape>(
  definition: ToolDefinition<Schema>,
) {
  return definition;
}

export const CLOSE_PAGE_ERROR =
  'The last open page cannot be closed. It is fine to keep it open.';

export const timeoutSchema = {
  timeout: zod
    .number()
    .int()
    .optional()
    .describe(
      `Maximum wait time in milliseconds. If set to 0, the default timeout will be used.`,
    )
    .transform(value => {
      return value && value <= 0 ? undefined : value;
    }),
};
