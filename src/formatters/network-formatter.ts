/**
 * @license
 * Copyright 2025 ReverseCraft
 * SPDX-License-Identifier: Apache-2.0
 */

import {isUtf8} from 'node:buffer';

import type {HTTPRequest, HTTPResponse} from '../third-party/index.js';
import {getConfig} from '../utils/config.js';

/**
 * Truncate URL for display in request lists.
 * Preserves the origin and truncates the path/query if too long.
 */
export function truncateUrl(url: string, maxLength: number): string {
  if (url.length <= maxLength) {
    return url;
  }

  try {
    const urlObj = new URL(url);
    const origin = urlObj.origin;
    const pathAndQuery = urlObj.pathname + urlObj.search;

    // If origin alone is too long, just truncate the whole URL
    if (origin.length >= maxLength - 10) {
      return url.substring(0, maxLength - 3) + '...';
    }

    // Calculate remaining space for path
    const remainingLength = maxLength - origin.length - 3; // 3 for "..."
    if (remainingLength <= 0) {
      return origin + '...';
    }

    // Truncate path/query, keeping the beginning
    const truncatedPath = pathAndQuery.substring(0, remainingLength);
    return origin + truncatedPath + '...';
  } catch {
    // If URL parsing fails, just truncate from the end
    return url.substring(0, maxLength - 3) + '...';
  }
}

export function getShortDescriptionForRequest(
  request: HTTPRequest,
  id: number,
  selectedInDevToolsUI = false,
): string {
  const config = getConfig();
  const truncatedUrl = truncateUrl(request.url(), config.maxUrlLength);
  return `reqid=${id} ${request.method()} ${truncatedUrl} ${getStatusFromRequest(request)}${selectedInDevToolsUI ? ` [selected in the DevTools Network panel]` : ''}`;
}

export function getStatusFromRequest(request: HTTPRequest): string {
  const httpResponse = request.response();
  const failure = request.failure();
  let status: string;
  if (httpResponse) {
    const responseStatus = httpResponse.status();
    status =
      responseStatus >= 200 && responseStatus <= 299
        ? `[success - ${responseStatus}]`
        : `[failed - ${responseStatus}]`;
  } else if (failure) {
    status = `[failed - ${failure.errorText}]`;
  } else {
    status = '[pending]';
  }
  return status;
}

export function getFormattedHeaderValue(
  headers: Record<string, string>,
): string[] {
  const response: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    response.push(`- ${name}:${value}`);
  }
  return response;
}

export async function getFormattedResponseBody(
  httpResponse: HTTPResponse,
  sizeLimit = getConfig().maxBodySize,
): Promise<string | undefined> {
  try {
    const responseBuffer = await httpResponse.buffer();

    if (isUtf8(responseBuffer)) {
      const responseAsTest = responseBuffer.toString('utf-8');

      if (responseAsTest.length === 0) {
        return `<empty response>`;
      }

      return `${getSizeLimitedString(responseAsTest, sizeLimit)}`;
    }

    return `<binary data>`;
  } catch {
    return `<not available anymore>`;
  }
}

export async function getFormattedRequestBody(
  httpRequest: HTTPRequest,
  sizeLimit: number = getConfig().maxBodySize,
): Promise<string | undefined> {
  if (httpRequest.hasPostData()) {
    const data = httpRequest.postData();

    if (data) {
      return `${getSizeLimitedString(data, sizeLimit)}`;
    }

    try {
      const fetchData = await httpRequest.fetchPostData();

      if (fetchData) {
        return `${getSizeLimitedString(fetchData, sizeLimit)}`;
      }
    } catch {
      return `<not available anymore>`;
    }
  }

  return;
}

function getSizeLimitedString(text: string, sizeLimit: number) {
  if (text.length > sizeLimit) {
    return `${text.substring(0, sizeLimit) + '... <truncated>'}`;
  }

  return `${text}`;
}

/**
 * Format URL for detailed request view.
 * Shows origin + path, with query params formatted separately and truncated if too long.
 * This provides more readable output than a single long URL string.
 */
export function formatUrlForDetail(url: string, maxParamValueLength = 100): string[] {
  const lines: string[] = [];

  try {
    const urlObj = new URL(url);
    const baseUrl = urlObj.origin + urlObj.pathname;
    lines.push(baseUrl);

    // Format query params separately if present
    if (urlObj.search) {
      const params = urlObj.searchParams;
      const paramEntries = Array.from(params.entries());

      if (paramEntries.length > 0) {
        lines.push('Query Parameters:');
        for (const [key, value] of paramEntries) {
          const truncatedValue =
            value.length > maxParamValueLength
              ? value.substring(0, maxParamValueLength) + '...<truncated>'
              : value;
          lines.push(`  ${key}: ${truncatedValue}`);
        }
      }
    }
  } catch {
    // If URL parsing fails, just return the truncated URL
    const config = getConfig();
    lines.push(truncateUrl(url, config.maxUrlLength * 2));
  }

  return lines;
}
