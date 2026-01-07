/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Network tools for rc-devtools-mcp.
 * Provides network request listing, searching, and saving capabilities.
 */

import {truncateUrl} from '../formatters/network-formatter.js';
import {zod} from '../third-party/index.js';
import {formatInitiator} from '../utils/cdp.js';
import {getConfig} from '../utils/config.js';
import {paginate} from '../utils/pagination.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './tool-definition.js';
import type {Context} from './tool-definition.js';

type NetworkHttpRequest = ReturnType<Context['getNetworkRequestById']>;

interface SearchMatch {
  location: 'url' | 'request-headers' | 'request-body' | 'response-headers' | 'response-body';
  snippet: string;
}

interface SearchResult {
  reqid: number;
  method: string;
  url: string;
  status: string;
  matches: SearchMatch[];
}

/**
 * Extract a snippet around a match with context and highlight the match.
 */
function extractSnippet(text: string, searchTerm: string, maxLength: number): string {
  const lowerText = text.toLowerCase();
  const lowerSearch = searchTerm.toLowerCase();
  const matchIndex = lowerText.indexOf(lowerSearch);
  
  if (matchIndex === -1) return '';
  
  // Calculate context around the match
  const contextSize = Math.floor((maxLength - searchTerm.length) / 2);
  const start = Math.max(0, matchIndex - contextSize);
  const end = Math.min(text.length, matchIndex + searchTerm.length + contextSize);
  
  let snippet = text.substring(start, end);
  
  // Add ellipsis if truncated
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';
  
  // Highlight the match with ** markers
  const matchStart = matchIndex - start + (start > 0 ? 3 : 0);
  const matchEnd = matchStart + searchTerm.length;
  snippet = snippet.substring(0, matchStart) + 
            '**' + snippet.substring(matchStart, matchEnd) + '**' + 
            snippet.substring(matchEnd);
  
  return snippet;
}


/**
 * Search for a term in text and return all matching snippets.
 */
function findAllMatches(text: string, searchTerm: string, maxLength: number, maxMatches = 3): string[] {
  const results: string[] = [];
  const lowerText = text.toLowerCase();
  const lowerSearch = searchTerm.toLowerCase();
  let lastIndex = 0;
  
  while (results.length < maxMatches) {
    const matchIndex = lowerText.indexOf(lowerSearch, lastIndex);
    if (matchIndex === -1) break;
    
    const contextSize = Math.floor((maxLength - searchTerm.length) / 2);
    const start = Math.max(0, matchIndex - contextSize);
    const end = Math.min(text.length, matchIndex + searchTerm.length + contextSize);
    
    let snippet = text.substring(start, end);
    if (start > 0) snippet = '...' + snippet;
    if (end < text.length) snippet = snippet + '...';
    
    // Highlight the match
    const relMatchStart = matchIndex - start + (start > 0 ? 3 : 0);
    const relMatchEnd = relMatchStart + searchTerm.length;
    snippet = snippet.substring(0, relMatchStart) + 
              '**' + snippet.substring(relMatchStart, relMatchEnd) + '**' + 
              snippet.substring(relMatchEnd);
    
    results.push(snippet);
    lastIndex = matchIndex + searchTerm.length;
  }
  
  return results;
}

/**
 * Format headers as a single string for searching.
 */
function formatHeadersForSearch(headers: Record<string, string>): string {
  return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n');
}

const FILTERABLE_RESOURCE_TYPES = [
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'prefetch',
  'eventsource',
  'websocket',
  'manifest',
  'signedexchange',
  'ping',
  'cspviolationreport',
  'preflight',
  'fedcm',
  'other',
] as const;

export const listNetworkRequests = defineTool({
  name: 'list_network_requests',
  description: `List all requests for the currently selected page since the last navigation. Supports optional keyword filtering.`,
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  schema: {
    keyword: zod
      .string()
      .optional()
      .describe(
        'Filter requests by keyword in URL, request/response headers, or request/response bodies. When omitted or empty, returns all requests.',
      ),
    pageSize: zod
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Maximum number of requests to return. When omitted, returns all requests.',
      ),
    pageIdx: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Page number to return (0-based). When omitted, returns the first page.',
      ),
    resourceTypes: zod
      .array(zod.enum(FILTERABLE_RESOURCE_TYPES))
      .optional()
      .describe(
        'Filter requests to only return requests of the specified resource types. When omitted or empty, returns all requests.',
      ),
    includePreservedRequests: zod
      .boolean()
      .default(false)
      .optional()
      .describe(
        'Set to true to return the preserved requests over the last 3 navigations.',
      ),
  },
  handler: async (request, response, context) => {
    const {keyword, pageSize, pageIdx, resourceTypes, includePreservedRequests} = request.params;

    // If keyword is provided, perform keyword-based filtering with snippet output
    if (keyword && keyword.trim()) {
      const config = getConfig();
      let requests = context.getNetworkRequests(includePreservedRequests);

      // Apply resource type filtering if specified
      if (resourceTypes?.length) {
        const normalizedTypes = new Set<string>(resourceTypes);
        requests = requests.filter(req => normalizedTypes.has(req.resourceType()));
      }

      const searchResults: SearchResult[] = [];
      const searchTerm = keyword.trim();

      // Process requests with timeout protection
      const RESPONSE_BODY_TIMEOUT = 5000; // 5 seconds timeout per response body
      const MAX_RESPONSE_BODY_SIZE = 10 * 1024 * 1024; // 10MB limit

      for (const httpRequest of requests) {
        const matches: SearchMatch[] = [];
        const reqid = context.getNetworkRequestStableId(httpRequest);

        // Search in URL
        const url = httpRequest.url();
        if (url.toLowerCase().includes(searchTerm.toLowerCase())) {
          const snippet = extractSnippet(url, searchTerm, config.maxSnippetLength);
          if (snippet) matches.push({location: 'url', snippet});
        }

        // Search in request headers
        const reqHeaders = formatHeadersForSearch(httpRequest.headers());
        if (reqHeaders.toLowerCase().includes(searchTerm.toLowerCase())) {
          const snippets = findAllMatches(reqHeaders, searchTerm, config.maxSnippetLength, 2);
          for (const snippet of snippets) {
            matches.push({location: 'request-headers', snippet});
          }
        }

        // Search in request body
        try {
          const reqBody = httpRequest.postData?.() ?? '';
          if (reqBody && reqBody.toLowerCase().includes(searchTerm.toLowerCase())) {
            const snippets = findAllMatches(reqBody, searchTerm, config.maxSnippetLength, 2);
            for (const snippet of snippets) {
              matches.push({location: 'request-body', snippet});
            }
          }
        } catch {
          // Ignore request body errors
        }

        // Search in response headers and body
        const httpResponse = httpRequest.response();
        if (httpResponse) {
          const respHeaders = formatHeadersForSearch(httpResponse.headers());
          if (respHeaders.toLowerCase().includes(searchTerm.toLowerCase())) {
            const snippets = findAllMatches(respHeaders, searchTerm, config.maxSnippetLength, 2);
            for (const snippet of snippets) {
              matches.push({location: 'response-headers', snippet});
            }
          }

          // Search in response body with timeout and size limit
          try {
            const respContentType = httpResponse.headers()['content-type'] ?? '';
            const contentLength = httpResponse.headers()['content-length'];
            const bodySize = contentLength ? parseInt(contentLength, 10) : 0;

            // Skip if body is too large
            if (bodySize > 0 && bodySize > MAX_RESPONSE_BODY_SIZE) {
              matches.push({
                location: 'response-body',
                snippet: `<skipped: response body too large (${(bodySize / 1024 / 1024).toFixed(2)}MB)>`
              });
            } else if (isProbablyTextContentType(respContentType)) {
              // Add timeout protection
              const textPromise = httpResponse.text();
              const timeoutPromise = new Promise<string>((_, reject) => {
                setTimeout(() => reject(new Error('timeout')), RESPONSE_BODY_TIMEOUT);
              });

              const respBody = await Promise.race([textPromise, timeoutPromise]);
              
              // Check size after fetching
              if (respBody.length > MAX_RESPONSE_BODY_SIZE) {
                matches.push({
                  location: 'response-body',
                  snippet: `<skipped: response body too large (${(respBody.length / 1024 / 1024).toFixed(2)}MB)>`
                });
              } else if (respBody && respBody.toLowerCase().includes(searchTerm.toLowerCase())) {
                const snippets = findAllMatches(respBody, searchTerm, config.maxSnippetLength, 3);
                for (const snippet of snippets) {
                  matches.push({location: 'response-body', snippet});
                }
              }
            }
          } catch (error) {
            // Log timeout or other errors
            if (error instanceof Error && error.message === 'timeout') {
              matches.push({
                location: 'response-body',
                snippet: '<skipped: response body fetch timeout>'
              });
            }
            // Ignore other response body errors
          }
        }

        if (matches.length > 0) {
          const status = httpResponse
            ? `${httpResponse.status()}`
            : httpRequest.failure()
              ? `failed: ${httpRequest.failure()?.errorText}`
              : 'pending';

          searchResults.push({
            reqid,
            method: httpRequest.method(),
            url: httpRequest.url(),
            status,
            matches,
          });
        }
      }

      // Apply pagination
      const paginationResult = paginate(searchResults, {pageSize, pageIdx});

      response.appendResponseLine(`## Network requests matching "${keyword}" (${searchResults.length} matches)`);
      
      if (paginationResult.totalPages > 1) {
        response.appendResponseLine(
          `Showing ${paginationResult.startIndex + 1}-${paginationResult.endIndex} of ${searchResults.length} (Page ${paginationResult.currentPage + 1} of ${paginationResult.totalPages})`
        );
        if (paginationResult.hasNextPage) {
          response.appendResponseLine(`Next page: pageIdx=${paginationResult.currentPage + 1}`);
        }
      }
      response.appendResponseLine('');

      for (const result of paginationResult.items) {
        const truncatedUrl = truncateUrl(result.url, config.maxUrlLength);
        response.appendResponseLine(`**reqid=${result.reqid}** ${result.method} ${truncatedUrl} [${result.status}]`);
        for (const match of result.matches) {
          response.appendResponseLine(`  ${match.location}: ${match.snippet}`);
        }
        response.appendResponseLine('');
      }

      if (searchResults.length === 0) {
        response.appendResponseLine('No matches found.');
      }

      return;
    }

    // Original behavior when keyword is not provided
    const data = await context.getDevToolsData();
    if (data && (data.cdpRequestId || data.cdpBackendNodeId)) {
      response.attachDevToolsData(data);
    }
    const reqid = data?.cdpRequestId
      ? context.resolveCdpRequestId(data.cdpRequestId)
      : undefined;
    response.setIncludeNetworkRequests(true, {
      pageSize,
      pageIdx,
      resourceTypes,
      includePreservedRequests,
      networkRequestIdInDevToolsUI: reqid,
    });
  },
});


export const getNetworkRequest = defineTool({
  name: 'get_network_request',
  description: `Get a network request by reqid, or the currently selected request in DevTools if omitted.`,
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  schema: {
    reqid: zod
      .number()
      .optional()
      .describe(
        'The reqid of the network request. If omitted returns the currently selected request in the DevTools Network panel.',
      ),
  },
  handler: async (request, response, context) => {
    if (request.params.reqid) {
      response.attachNetworkRequest(request.params.reqid);
    } else {
      const data = await context.getDevToolsData();
      if (data && (data.cdpRequestId || data.cdpBackendNodeId)) {
        response.attachDevToolsData(data);
      }
      const reqid = data?.cdpRequestId
        ? context.resolveCdpRequestId(data.cdpRequestId)
        : undefined;
      if (reqid) {
        response.attachNetworkRequest(reqid);
      } else {
        response.appendResponseLine(
          `Nothing is currently selected in the DevTools Network panel.`,
        );
      }
    }
  },
});


function getExtensionFromContentType(contentType: string | undefined): string {
  if (!contentType) return '.bin';
  const ct = contentType.toLowerCase();
  if (ct.includes('image/png')) return '.png';
  if (ct.includes('image/jpeg') || ct.includes('image/jpg')) return '.jpg';
  if (ct.includes('image/webp')) return '.webp';
  if (ct.includes('application/pdf')) return '.pdf';
  if (ct.includes('application/zip')) return '.zip';
  if (ct.includes('application/gzip') || ct.includes('application/x-gzip'))
    return '.gz';
  if (ct.includes('application/octet-stream')) return '.bin';
  if (ct.includes('multipart/form-data')) return '.bin';
  return '.bin';
}

function getDeriveBinaryBodyPath(
  filePath: string,
  contentType: string | undefined,
  suffix: 'request-body' | 'response-body' = 'response-body',
) {
  const ext = getExtensionFromContentType(contentType);
  const withoutExt = filePath.replace(/\.[^./\\]+$/, '');
  return `${withoutExt}.${suffix}${ext}`;
}

function formatHeadersLines(headers: Record<string, string>): string[] {
  // Preserve insertion order (Object.entries) which is stable in JS engines.
  return Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
}

function isProbablyTextContentType(contentType: string | undefined): boolean {
  if (!contentType) return true;
  const ct = contentType.toLowerCase();
  if (ct.startsWith('text/')) return true;
  if (ct.includes('application/json')) return true;
  if (ct.includes('application/javascript')) return true;
  if (ct.includes('application/xml')) return true;
  if (ct.includes('application/x-www-form-urlencoded')) return true;
  if (ct.includes('+json')) return true;
  if (ct.includes('+xml')) return true;
  return false;
}

async function getFullRequestBody(
  httpRequest: NetworkHttpRequest,
): Promise<string | undefined> {
  // Puppeteer request bodies are strings; use fetchPostData first since it can be
  // available even when postData() is empty.
  try {
    if (httpRequest?.hasPostData?.()) {
      const data = await httpRequest.fetchPostData?.().catch(() => undefined);
      if (typeof data === 'string') return data;
      const fallback = httpRequest.postData?.();
      if (typeof fallback === 'string') return fallback;
    }
  } catch {
    // Ignore.
  }
  return undefined;
}

export const saveNetworkRequest = defineTool({
  name: 'save_network_request',
  description: 'Save a network request and response to a local file in raw HTTP format.',
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: false,
  },
  schema: {
    reqid: zod
      .number()
      .optional()
      .describe(
        'The reqid of the network request. If omitted, uses the currently selected request in the DevTools Network panel.',
      ),
    filePath: zod
      .string()
      .describe('Absolute or relative file path where the HTTP transaction will be saved.'),
    responseBodyFilePath: zod
      .string()
      .optional()
      .describe(
        'Optional file path to save the response body when it is binary. When omitted, it will be derived from filePath.',
      ),
    saveRequestBody: zod
      .boolean()
      .optional()
      .describe(
        'When true, also saves the request body to a separate file. Useful for binary or encoded request bodies.',
      ),
    requestBodyFilePath: zod
      .string()
      .optional()
      .describe(
        'Optional file path to save the request body. When omitted but saveRequestBody is true, it will be derived from filePath.',
      ),
  },
  handler: async (request, response, context) => {
    let reqid = request.params.reqid;
    if (!reqid) {
      const data = await context.getDevToolsData();
      if (data && (data.cdpRequestId || data.cdpBackendNodeId)) {
        response.attachDevToolsData(data);
      }
      reqid = data?.cdpRequestId ? context.resolveCdpRequestId(data.cdpRequestId) : undefined;
    }

    if (!reqid) {
      response.appendResponseLine(
        `Nothing is currently selected in the DevTools Network panel.`,
      );
      return;
    }

    const httpRequest = context.getNetworkRequestById(reqid);

    // --- Request ---
    let urlObj: URL | null = null;
    try {
      urlObj = new URL(httpRequest.url());
    } catch {
      urlObj = null;
    }

    const method = httpRequest.method();
    const requestTarget = urlObj
      ? `${urlObj.pathname || '/'}${urlObj.search || ''}`
      : httpRequest.url();

    const requestHeaders: Record<string, string> = {...httpRequest.headers()};
    if (urlObj && !('host' in requestHeaders) && !('Host' in requestHeaders)) {
      requestHeaders['host'] = urlObj.host;
    }

    const requestBody = await getFullRequestBody(httpRequest);
    const requestContentType = requestHeaders['content-type'] ?? requestHeaders['Content-Type'];
    let requestBodySavedTo: string | undefined;

    const requestLines: string[] = [];
    requestLines.push(`${method} ${requestTarget} HTTP/1.1`);
    requestLines.push(...formatHeadersLines(requestHeaders));
    requestLines.push('');
    if (requestBody) {
      // Always include request body in the main file
      requestLines.push(requestBody);

      // Optionally save request body to a separate file
      const shouldSaveRequestBody = request.params.saveRequestBody || request.params.requestBodyFilePath;
      if (shouldSaveRequestBody) {
        const bodyPath =
          request.params.requestBodyFilePath ??
          getDeriveBinaryBodyPath(request.params.filePath, requestContentType, 'request-body');
        const encoder = new TextEncoder();
        await context.saveFile(encoder.encode(requestBody), bodyPath);
        requestBodySavedTo = bodyPath;
      }
    }

    // --- Response ---
    const httpResponse = httpRequest.response();
    const responseLines: string[] = [];
    let binaryBodySavedTo: string | undefined;

    if (httpResponse) {
      const status = httpResponse.status();
      const statusText =
        (httpResponse as unknown as {statusText?: () => string}).statusText?.() ??
        '';
      responseLines.push(`HTTP/1.1 ${status}${statusText ? ` ${statusText}` : ''}`);
      const headers = httpResponse.headers();
      responseLines.push(...formatHeadersLines(headers));
      responseLines.push('');

      const contentType = headers['content-type'];
      if (isProbablyTextContentType(contentType)) {
        try {
          const text = await httpResponse.text();
          if (text.length) {
            responseLines.push(text);
          }
        } catch {
          responseLines.push(`<response body not available anymore>`);
        }
      } else {
        try {
          const buf = await httpResponse.buffer();
          const bodyPath =
            request.params.responseBodyFilePath ??
            getDeriveBinaryBodyPath(request.params.filePath, contentType);
          await context.saveFile(new Uint8Array(buf), bodyPath);
          binaryBodySavedTo = bodyPath;
          responseLines.push(`<binary response body saved to: ${bodyPath}>`);
        } catch {
          responseLines.push(`<response body not available anymore>`);
        }
      }
    } else {
      responseLines.push(`HTTP/1.1 000 <pending/no response>`);
      responseLines.push('');
    }

    // --- Initiator ---
    const initiatorLines: string[] = [];
    const initiator = context.getNetworkRequestInitiator(reqid);
    if (initiator) {
      initiatorLines.push('=== Initiator ===');
      for (const line of formatInitiator(initiator)) {
        initiatorLines.push(line);
      }
    }

    const fileContent = [...requestLines, '', ...responseLines, '', ...initiatorLines].join('\r\n');
    await context.saveFile(new TextEncoder().encode(fileContent), request.params.filePath);

    response.appendResponseLine(
      `Saved network request reqid=${reqid} to ${request.params.filePath}.`,
    );
    if (requestBodySavedTo) {
      response.appendResponseLine(`Saved request body to ${requestBodySavedTo}.`);
    }
    if (binaryBodySavedTo) {
      response.appendResponseLine(`Saved binary response body to ${binaryBodySavedTo}.`);
    }
  },
});


/**
 * Derive filename from URL path.
 */
function getFilenameFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    // Get the last path segment
    const segments = pathname.split('/').filter(s => s.length > 0);
    if (segments.length > 0) {
      const lastSegment = segments[segments.length - 1];
      // Remove query params if somehow included
      return lastSegment.split('?')[0];
    }
  } catch {
    // Ignore URL parsing errors
  }
  return 'resource';
}

/**
 * Get file extension from content type for static resources.
 */
function getStaticResourceExtension(contentType: string | undefined, url: string): string {
  // First, try to get extension from URL
  const urlFilename = getFilenameFromUrl(url);
  const urlExtMatch = urlFilename.match(/\.([a-zA-Z0-9]+)$/);
  if (urlExtMatch) {
    return '.' + urlExtMatch[1];
  }

  // Fall back to content type
  if (!contentType) return '';
  const ct = contentType.toLowerCase();

  // JavaScript
  if (ct.includes('javascript') || ct.includes('ecmascript')) return '.js';
  // CSS
  if (ct.includes('text/css')) return '.css';
  // HTML
  if (ct.includes('text/html')) return '.html';
  // JSON
  if (ct.includes('application/json') || ct.includes('+json')) return '.json';
  // XML
  if (ct.includes('application/xml') || ct.includes('text/xml') || ct.includes('+xml')) return '.xml';
  // Images
  if (ct.includes('image/png')) return '.png';
  if (ct.includes('image/jpeg') || ct.includes('image/jpg')) return '.jpg';
  if (ct.includes('image/gif')) return '.gif';
  if (ct.includes('image/webp')) return '.webp';
  if (ct.includes('image/svg')) return '.svg';
  if (ct.includes('image/ico') || ct.includes('image/x-icon')) return '.ico';
  // Fonts
  if (ct.includes('font/woff2')) return '.woff2';
  if (ct.includes('font/woff')) return '.woff';
  if (ct.includes('font/ttf') || ct.includes('font/truetype')) return '.ttf';
  if (ct.includes('font/otf') || ct.includes('font/opentype')) return '.otf';
  // Other
  if (ct.includes('application/pdf')) return '.pdf';
  if (ct.includes('text/plain')) return '.txt';

  return '';
}

export const saveStaticResource = defineTool({
  name: 'save_static_resource',
  description: 'Save a static resource from a network request to a local file. File extension is automatically determined.',
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: false,
  },
  schema: {
    reqid: zod
      .number()
      .describe('The reqid of the network request containing the resource to save.'),
    filePath: zod
      .string()
      .describe(
        'Path to save the file. Can be a full file path (e.g., "/path/to/file.js") or a directory path (e.g., "/path/to/dir/"). If a directory, filename is derived from the URL.',
      ),
  },
  handler: async (request, response, context) => {
    const {reqid, filePath} = request.params;

    const httpRequest = context.getNetworkRequestById(reqid);
    if (!httpRequest) {
      response.appendResponseLine(`Error: Request with reqid=${reqid} not found.`);
      return;
    }

    const httpResponse = httpRequest.response();
    if (!httpResponse) {
      response.appendResponseLine(
        `Error: Request reqid=${reqid} has no response yet (pending or failed).`,
      );
      return;
    }

    const url = httpRequest.url();
    const contentType = httpResponse.headers()['content-type'];

    // Determine the final file path
    let finalPath = filePath;
    const isDirectory = filePath.endsWith('/') || filePath.endsWith('\\');

    if (isDirectory) {
      // Derive filename from URL
      let filename = getFilenameFromUrl(url);
      // Add extension if missing
      if (!filename.includes('.')) {
        const ext = getStaticResourceExtension(contentType, url);
        if (ext) filename += ext;
      }
      finalPath = filePath + filename;
    } else {
      // If path has no extension, add one based on content type
      if (!finalPath.match(/\.[a-zA-Z0-9]+$/)) {
        const ext = getStaticResourceExtension(contentType, url);
        if (ext) finalPath += ext;
      }
    }

    // Get the response body
    try {
      let savedFile: {filename: string};
      if (isProbablyTextContentType(contentType)) {
        const text = await httpResponse.text();
        savedFile = await context.saveFile(new TextEncoder().encode(text), finalPath);
      } else {
        const buffer = await httpResponse.buffer();
        savedFile = await context.saveFile(new Uint8Array(buffer), finalPath);
      }

      response.appendResponseLine(`Saved static resource from reqid=${reqid} to ${savedFile.filename}`);
      response.appendResponseLine(`Source URL: ${url}`);
      if (contentType) {
        response.appendResponseLine(`Content-Type: ${contentType}`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const cause = error instanceof Error && error.cause ? ` (cause: ${error.cause})` : '';
      response.appendResponseLine(`Error saving resource: ${errorMsg}${cause}`);
    }
  },
});
