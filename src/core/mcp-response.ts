/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP Response handler for rc-devtools-mcp.
 * Formats and structures responses from MCP tool executions.
 */

import {mapIssueToMessageObject} from '../utils/devtools-utils.js';
import type {ConsoleMessageData} from '../formatters/console-formatter.js';
import {
  formatConsoleEventShort,
  formatConsoleEventVerbose,
  formatConsoleMessagesForFile,
} from '../formatters/console-formatter.js';
import {
  formatUrlForDetail,
  getFormattedHeaderValue,
  getFormattedResponseBody,
  getFormattedRequestBody,
  getShortDescriptionForRequest,
  getStatusFromRequest,
} from '../formatters/network-formatter.js';
import {
  formatSnapshotNode,
  formatSnapshotWithOptions,
} from '../formatters/snapshot-formatter.js';
import type {McpContext} from './mcp-context.js';
import {DevTools} from '../third-party/index.js';
import type {
  ConsoleMessage,
  ImageContent,
  ResourceType,
  TextContent,
} from '../third-party/index.js';
import type {
  DevToolsData,
  ImageContentData,
  NetworkRequestFilter,
  Response,
  SnapshotParams,
} from '../tools/tool-definition.js';
import {formatInitiator} from '../utils/cdp.js';
import {paginate} from '../utils/pagination.js';
import type {PaginationOptions} from '../utils/types.js';

export class McpResponse implements Response {
  #includePages = false;
  #snapshotParams?: SnapshotParams;
  #attachedNetworkRequestId?: number;
  #attachedConsoleMessageId?: number;
  #textResponseLines: string[] = [];
  #images: ImageContentData[] = [];
  #networkRequestsOptions?: {
    include: boolean;
    pagination?: PaginationOptions;
    resourceTypes?: ResourceType[];
    includePreservedRequests?: boolean;
    networkRequestIdInDevToolsUI?: number;
    filter?: NetworkRequestFilter;
  };
  #consoleDataOptions?: {
    include: boolean;
    pagination?: PaginationOptions;
    types?: string[];
    includePreservedMessages?: boolean;
    savePath?: string;
    maxLineLength?: number;
  };
  #devToolsData?: DevToolsData;

  attachDevToolsData(data: DevToolsData): void {
    this.#devToolsData = data;
  }

  setIncludePages(value: boolean): void {
    this.#includePages = value;
  }

  includeSnapshot(params?: SnapshotParams): void {
    this.#snapshotParams = params ?? {
      verbose: false,
    };
  }

  setIncludeNetworkRequests(
    value: boolean,
    options?: PaginationOptions & {
      resourceTypes?: ResourceType[];
      includePreservedRequests?: boolean;
      networkRequestIdInDevToolsUI?: number;
      filter?: NetworkRequestFilter;
    },
  ): void {
    if (!value) {
      this.#networkRequestsOptions = undefined;
      return;
    }

    this.#networkRequestsOptions = {
      include: value,
      pagination:
        options?.pageSize || options?.pageIdx
          ? {
              pageSize: options.pageSize,
              pageIdx: options.pageIdx,
            }
          : undefined,
      resourceTypes: options?.resourceTypes,
      includePreservedRequests: options?.includePreservedRequests,
      networkRequestIdInDevToolsUI: options?.networkRequestIdInDevToolsUI,
      filter: options?.filter,
    };
  }

  setIncludeConsoleData(
    value: boolean,
    options?: PaginationOptions & {
      types?: string[];
      includePreservedMessages?: boolean;
      savePath?: string;
      maxLineLength?: number;
    },
  ): void {
    if (!value) {
      this.#consoleDataOptions = undefined;
      return;
    }

    this.#consoleDataOptions = {
      include: value,
      pagination:
        options?.pageSize || options?.pageIdx
          ? {
              pageSize: options.pageSize,
              pageIdx: options.pageIdx,
            }
          : undefined,
      types: options?.types,
      includePreservedMessages: options?.includePreservedMessages,
      savePath: options?.savePath,
      maxLineLength: options?.maxLineLength,
    };
  }

  attachNetworkRequest(reqid: number): void {
    this.#attachedNetworkRequestId = reqid;
  }

  attachConsoleMessage(msgid: number): void {
    this.#attachedConsoleMessageId = msgid;
  }

  get includePages(): boolean {
    return this.#includePages;
  }

  get includeNetworkRequests(): boolean {
    return this.#networkRequestsOptions?.include ?? false;
  }

  get includeConsoleData(): boolean {
    return this.#consoleDataOptions?.include ?? false;
  }

  get attachedNetworkRequestId(): number | undefined {
    return this.#attachedNetworkRequestId;
  }

  get networkRequestsPageIdx(): number | undefined {
    return this.#networkRequestsOptions?.pagination?.pageIdx;
  }

  get consoleMessagesPageIdx(): number | undefined {
    return this.#consoleDataOptions?.pagination?.pageIdx;
  }

  get consoleMessagesTypes(): string[] | undefined {
    return this.#consoleDataOptions?.types;
  }

  appendResponseLine(value: string): void {
    this.#textResponseLines.push(value);
  }

  attachImage(value: ImageContentData): void {
    this.#images.push(value);
  }

  get responseLines(): readonly string[] {
    return this.#textResponseLines;
  }

  get images(): ImageContentData[] {
    return this.#images;
  }

  get snapshotParams(): SnapshotParams | undefined {
    return this.#snapshotParams;
  }

  async handle(
    toolName: string,
    context: McpContext,
  ): Promise<Array<TextContent | ImageContent>> {
    if (this.#includePages) {
      await context.createPagesSnapshot();
    }

    let formattedSnapshot: string | undefined;
    if (this.#snapshotParams) {
      await context.createTextSnapshot(
        this.#snapshotParams.verbose,
        this.#devToolsData,
      );
      const snapshot = context.getTextSnapshot();
      if (snapshot) {
        const hasSearchOrPagination =
          this.#snapshotParams.search ||
          this.#snapshotParams.pageSize !== undefined ||
          this.#snapshotParams.pageIdx !== undefined;

        if (hasSearchOrPagination) {
          const result = formatSnapshotWithOptions(snapshot.root, snapshot, {
            search: this.#snapshotParams.search,
            pagination:
              this.#snapshotParams.pageSize !== undefined ||
              this.#snapshotParams.pageIdx !== undefined
                ? {
                    pageSize: this.#snapshotParams.pageSize,
                    pageIdx: this.#snapshotParams.pageIdx,
                  }
                : undefined,
          });

          const paginationInfo: string[] = [];
          if (this.#snapshotParams.search) {
            paginationInfo.push(
              `Search: "${this.#snapshotParams.search}" - Found ${result.matchedElements} of ${result.totalElements} elements`,
            );
          }
          if (result.totalPages > 1) {
            paginationInfo.push(
              `Page ${result.currentPage + 1} of ${result.totalPages}`,
            );
            if (result.hasNextPage) {
              paginationInfo.push(`Next page: pageIdx=${result.currentPage + 1}`);
            }
            if (result.hasPreviousPage) {
              paginationInfo.push(
                `Previous page: pageIdx=${result.currentPage - 1}`,
              );
            }
          }

          if (this.#snapshotParams.filePath) {
            const fullContent = paginationInfo.length
              ? paginationInfo.join('\n') + '\n\n' + result.content
              : result.content;
            await context.saveFile(
              new TextEncoder().encode(fullContent),
              this.#snapshotParams.filePath,
            );
            formattedSnapshot = `Saved snapshot to ${this.#snapshotParams.filePath}.`;
            if (paginationInfo.length) {
              formattedSnapshot += '\n' + paginationInfo.join('\n');
            }
          } else {
            formattedSnapshot = paginationInfo.length
              ? paginationInfo.join('\n') + '\n\n' + result.content
              : result.content;
          }
        } else {
          if (this.#snapshotParams.filePath) {
            await context.saveFile(
              new TextEncoder().encode(
                formatSnapshotNode(snapshot.root, snapshot),
              ),
              this.#snapshotParams.filePath,
            );
            formattedSnapshot = `Saved snapshot to ${this.#snapshotParams.filePath}.`;
          } else {
            formattedSnapshot = formatSnapshotNode(snapshot.root, snapshot);
          }
        }
      }
    }

    const bodies: {
      requestBody?: string;
      responseBody?: string;
    } = {};

    if (this.#attachedNetworkRequestId) {
      const request = context.getNetworkRequestById(
        this.#attachedNetworkRequestId,
      );

      bodies.requestBody = await getFormattedRequestBody(request);

      const response = request.response();
      if (response) {
        bodies.responseBody = await getFormattedResponseBody(response);
      }
    }

    let consoleData: ConsoleMessageData | undefined;

    if (this.#attachedConsoleMessageId) {
      const message = context.getConsoleMessageById(
        this.#attachedConsoleMessageId,
      );
      const consoleMessageStableId = this.#attachedConsoleMessageId;
      if ('args' in message) {
        const consoleMessage = message as ConsoleMessage;
        consoleData = {
          consoleMessageStableId,
          type: consoleMessage.type(),
          message: consoleMessage.text(),
          args: await Promise.all(
            consoleMessage.args().map(async arg => {
              const stringArg = await arg.jsonValue().catch(() => {
                // Ignore errors.
              });
              return typeof stringArg === 'object'
                ? JSON.stringify(stringArg)
                : String(stringArg);
            }),
          ),
        };
      } else if (message instanceof DevTools.AggregatedIssue) {
        const mappedIssueMessage = mapIssueToMessageObject(message);
        if (!mappedIssueMessage)
          throw new Error(
            "Can't provide detals for the msgid " + consoleMessageStableId,
          );
        consoleData = {
          consoleMessageStableId,
          ...mappedIssueMessage,
        };
      } else {
        consoleData = {
          consoleMessageStableId,
          type: 'error',
          message: (message as Error).message,
          args: [],
        };
      }
    }

    let consoleListData: ConsoleMessageData[] | undefined;
    if (this.#consoleDataOptions?.include) {
      let messages = context.getConsoleData(
        this.#consoleDataOptions.includePreservedMessages,
      );

      if (this.#consoleDataOptions.types?.length) {
        const normalizedTypes = new Set(this.#consoleDataOptions.types);
        messages = messages.filter(message => {
          if ('type' in message) {
            return normalizedTypes.has(message.type());
          }
          if (message instanceof DevTools.AggregatedIssue) {
            return normalizedTypes.has('issue');
          }
          return normalizedTypes.has('error');
        });
      }

      consoleListData = (
        await Promise.all(
          messages.map(async (item): Promise<ConsoleMessageData | null> => {
            const consoleMessageStableId =
              context.getConsoleMessageStableId(item);
            if ('args' in item) {
              const consoleMessage = item as ConsoleMessage;
              return {
                consoleMessageStableId,
                type: consoleMessage.type(),
                message: consoleMessage.text(),
                args: await Promise.all(
                  consoleMessage.args().map(async arg => {
                    const stringArg = await arg.jsonValue().catch(() => {
                      // Ignore errors.
                    });
                    return typeof stringArg === 'object'
                      ? JSON.stringify(stringArg)
                      : String(stringArg);
                  }),
                ),
              };
            }
            if (item instanceof DevTools.AggregatedIssue) {
              const mappedIssueMessage = mapIssueToMessageObject(item);
              if (!mappedIssueMessage) return null;
              return {
                consoleMessageStableId,
                ...mappedIssueMessage,
              };
            }
            return {
              consoleMessageStableId,
              type: 'error',
              message: (item as Error).message,
              args: [],
            };
          }),
        )
      ).filter(item => item !== null);

      if (this.#consoleDataOptions.savePath && consoleListData) {
        const fileContent = formatConsoleMessagesForFile(consoleListData);
        await context.saveFile(
          new TextEncoder().encode(fileContent),
          this.#consoleDataOptions.savePath,
        );
      }
    }

    return this.format(toolName, context, {
      bodies,
      consoleData,
      consoleListData,
      formattedSnapshot,
    });
  }


  format(
    toolName: string,
    context: McpContext,
    data: {
      bodies: {
        requestBody?: string;
        responseBody?: string;
      };
      consoleData: ConsoleMessageData | undefined;
      consoleListData: ConsoleMessageData[] | undefined;
      formattedSnapshot: string | undefined;
    },
  ): Array<TextContent | ImageContent> {
    const response = [`# ${toolName} response`];
    for (const line of this.#textResponseLines) {
      response.push(line);
    }

    const networkConditions = context.getNetworkConditions();
    if (networkConditions) {
      response.push(`## Network emulation`);
      response.push(`Emulating: ${networkConditions}`);
      response.push(
        `Default navigation timeout set to ${context.getNavigationTimeout()} ms`,
      );
    }

    const cpuThrottlingRate = context.getCpuThrottlingRate();
    if (cpuThrottlingRate > 1) {
      response.push(`## CPU emulation`);
      response.push(`Emulating: ${cpuThrottlingRate}x slowdown`);
    }

    const dialog = context.getDialog();
    if (dialog) {
      const defaultValueIfNeeded =
        dialog.type() === 'prompt'
          ? ` (default value: "${dialog.defaultValue()}")`
          : '';
      response.push(`# Open dialog
${dialog.type()}: ${dialog.message()}${defaultValueIfNeeded}.`);
    }

    if (this.#includePages) {
      const parts = [`## Pages`];
      let idx = 0;
      for (const page of context.getPages()) {
        parts.push(
          `${idx}: ${page.url()}${context.isPageSelected(page) ? ' [selected]' : ''}`,
        );
        idx++;
      }
      response.push(...parts);
    }

    if (data.formattedSnapshot) {
      response.push('## Latest page snapshot');
      response.push(data.formattedSnapshot);
    }

    response.push(...this.#formatNetworkRequestData(context, data.bodies));
    response.push(...this.#formatConsoleData(context, data.consoleData));

    if (this.#networkRequestsOptions?.include) {
      let requests = context.getNetworkRequests(
        this.#networkRequestsOptions?.includePreservedRequests,
      );

      if (this.#networkRequestsOptions.resourceTypes?.length) {
        const normalizedTypes = new Set(
          this.#networkRequestsOptions.resourceTypes,
        );
        requests = requests.filter(request => {
          const type = request.resourceType();
          return normalizedTypes.has(type);
        });
      }

      if (this.#networkRequestsOptions.filter) {
        requests = requests.filter(this.#networkRequestsOptions.filter);
      }

      response.push('## Network requests');
      if (requests.length) {
        const data = this.#dataWithPagination(
          requests,
          this.#networkRequestsOptions.pagination,
        );
        response.push(...data.info);
        for (const request of data.items) {
          response.push(
            getShortDescriptionForRequest(
              request,
              context.getNetworkRequestStableId(request),
              context.getNetworkRequestStableId(request) ===
                this.#networkRequestsOptions?.networkRequestIdInDevToolsUI,
            ),
          );
        }
      } else {
        response.push('No requests found.');
      }
    }

    if (this.#consoleDataOptions?.include) {
      const messages = data.consoleListData ?? [];

      response.push('## Console messages');

      if (this.#consoleDataOptions.savePath) {
        response.push(
          `Saved ${messages.length} console messages to ${this.#consoleDataOptions.savePath}`,
        );
      } else if (messages.length) {
        const data = this.#dataWithPagination(
          messages,
          this.#consoleDataOptions.pagination,
        );
        response.push(...data.info);
        const maxLineLength = this.#consoleDataOptions.maxLineLength ?? 500;
        response.push(
          ...data.items.map(message =>
            formatConsoleEventShort(message, maxLineLength),
          ),
        );
      } else {
        response.push('<no console messages found>');
      }
    }

    const text: TextContent = {
      type: 'text',
      text: response.join('\n'),
    };
    const images: ImageContent[] = this.#images.map(imageData => {
      return {
        type: 'image',
        ...imageData,
      } as const;
    });

    return [text, ...images];
  }

  #dataWithPagination<T>(data: T[], pagination?: PaginationOptions) {
    const response = [];
    const paginationResult = paginate<T>(data, pagination);
    if (paginationResult.invalidPage) {
      response.push('Invalid page number provided. Showing first page.');
    }

    const {startIndex, endIndex, currentPage, totalPages} = paginationResult;
    response.push(
      `Showing ${startIndex + 1}-${endIndex} of ${data.length} (Page ${currentPage + 1} of ${totalPages}).`,
    );
    if (pagination) {
      if (paginationResult.hasNextPage) {
        response.push(`Next page: ${currentPage + 1}`);
      }
      if (paginationResult.hasPreviousPage) {
        response.push(`Previous page: ${currentPage - 1}`);
      }
    }

    return {
      info: response,
      items: paginationResult.items,
    };
  }

  #formatConsoleData(
    context: McpContext,
    data: ConsoleMessageData | undefined,
  ): string[] {
    const response: string[] = [];
    if (!data) {
      return response;
    }

    response.push(formatConsoleEventVerbose(data, context));
    return response;
  }

  #formatNetworkRequestData(
    context: McpContext,
    data: {
      requestBody?: string;
      responseBody?: string;
    },
  ): string[] {
    const response: string[] = [];
    const id = this.#attachedNetworkRequestId;
    if (!id) {
      return response;
    }

    const httpRequest = context.getNetworkRequestById(id);
    const urlLines = formatUrlForDetail(httpRequest.url());
    response.push(`## Request ${urlLines[0]}`);
    for (let i = 1; i < urlLines.length; i++) {
      response.push(urlLines[i]);
    }
    response.push(`Status:  ${getStatusFromRequest(httpRequest)}`);
    response.push(`### Request Headers`);
    for (const line of getFormattedHeaderValue(httpRequest.headers())) {
      response.push(line);
    }

    if (data.requestBody) {
      response.push(`### Request Body`);
      response.push(data.requestBody);
    }

    const httpResponse = httpRequest.response();
    if (httpResponse) {
      response.push(`### Response Headers`);
      for (const line of getFormattedHeaderValue(httpResponse.headers())) {
        response.push(line);
      }
    }

    if (data.responseBody) {
      response.push(`### Response Body`);
      response.push(data.responseBody);
    }

    const httpFailure = httpRequest.failure();
    if (httpFailure) {
      response.push(`### Request failed with`);
      response.push(httpFailure.errorText);
    }

    const redirectChain = httpRequest.redirectChain();
    if (redirectChain.length) {
      response.push(`### Redirect chain`);
      let indent = 0;
      for (const request of redirectChain.reverse()) {
        response.push(
          `${'  '.repeat(indent)}${getShortDescriptionForRequest(request, context.getNetworkRequestStableId(request))}`,
        );
        indent++;
      }
    }

    try {
      const initiator = context.getNetworkRequestInitiator(id);
      if (initiator) {
        response.push(`### Initiator`);
        for (const line of formatInitiator(initiator)) {
          response.push(line);
        }
      }
    } catch {
      // Initiator info may not be available for all requests
    }
    return response;
  }

  resetResponseLineForTesting() {
    this.#textResponseLines = [];
  }
}
