# Tool Reference

Complete reference for all tools available in ReverseCraft DevTools MCP.

## Input Automation

### click

Click on an element on the page.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `uid` | string | Yes | The uid of an element from the page content snapshot |
| `dblClick` | boolean | No | Set to true for double clicks. Default is false |

### fill

Type text into an input, text area, or select an option from a `<select>` element.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `uid` | string | Yes | The uid of an element from the page content snapshot |
| `value` | string | Yes | The value to fill in |

### press_key

Press a key or key combination for keyboard shortcuts and navigation keys.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `key` | string | Yes | A key or combination (e.g., "Enter", "Control+A", "Control+Shift+R"). Modifiers: Control, Shift, Alt, Meta |

---

## Navigation

### navigate_page

Navigate the currently selected page to a URL.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `type` | enum | No | Navigate type: `url`, `back`, `forward`, `reload` |
| `url` | string | No | Target URL (only for type=url) |
| `ignoreCache` | boolean | No | Whether to ignore cache on reload |
| `enableDebugger` | boolean | No | Enable JavaScript debugger after navigation. Default is true |
| `timeout` | number | No | Navigation timeout in milliseconds |

### new_page

Create a new browser page.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `url` | string | Yes | URL to load in the new page |
| `incognito` | boolean | No | Open in a new incognito window |
| `newWindow` | boolean | No | Open in a new window |
| `userDataDir` | string | No | Independent user data directory for a new browser instance |
| `enableDebugger` | boolean | No | Enable JavaScript debugger. Default is true |
| `timeout` | number | No | Navigation timeout in milliseconds |

### close_page

Close a page by its index. The last open page cannot be closed.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pageIdx` | number | Yes | The index of the page to close |

### list_pages

Get a list of pages open in the browser.

**Parameters:** None

### select_page

Select a page as context for future tool calls.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pageIdx` | number | Yes | The index of the page to select |
| `bringToFront` | boolean | No | Focus the page and bring it to the top |

### clear_cookies

Clear browser cookies for all sites or a specific domain.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `url` | string | No | URL to clear cookies for a specific domain. If not provided, clears all cookies |

---

## Network

### list_network_requests

List all requests for the currently selected page since the last navigation.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pageSize` | number | No | Maximum number of requests to return |
| `pageIdx` | number | No | Page number to return (0-based) |
| `resourceTypes` | array | No | Filter by resource types: `document`, `stylesheet`, `image`, `media`, `font`, `script`, `xhr`, `fetch`, etc. |
| `includePreservedRequests` | boolean | No | Include preserved requests over the last 3 navigations |

### get_network_request

Get a network request by reqid, or the currently selected request in DevTools.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `reqid` | number | No | The reqid of the network request. If omitted, returns the currently selected request in DevTools |

### save_network_request

Save a network request and response to a local file in raw HTTP format.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `reqid` | number | No | The reqid of the request. If omitted, uses the currently selected request |
| `filePath` | string | Yes | File path to save the HTTP transaction |
| `responseBodyFilePath` | string | No | File path for binary response body |
| `saveRequestBody` | boolean | No | Also save request body to a separate file |
| `requestBodyFilePath` | string | No | File path for request body |

### save_static_resource

Save a static resource from a network request to a local file.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `reqid` | number | Yes | The reqid of the network request |
| `filePath` | string | Yes | Path to save the file. Can be a full path or directory |

---

## Debugging

### set_breakpoint

Set a JavaScript breakpoint at a specific line in a file matching a URL pattern.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `urlRegex` | string | Yes | Regular expression to match the script URL |
| `lineNumber` | number | Yes | Line number (1-based) |
| `columnNumber` | number | No | Target column number (0-based) for smart snapping |
| `snapRange` | number | No | Search range for finding valid breakpoint positions. Default: 100 |
| `condition` | string | No | JavaScript expression. Breakpoint only triggers when true |

### remove_breakpoint

Remove a previously set JavaScript breakpoint by its CDP breakpoint ID.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `breakpointId` | string | Yes | The CDP breakpoint ID to remove |

### list_breakpoints

List all active JavaScript breakpoints on the current page.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `searchTerm` | string | No | Filter breakpoints by ID or URL pattern |
| `pageSize` | number | No | Maximum breakpoints per page |
| `pageIdx` | number | No | Page number (0-based) |

### clear_all_breakpoints

Remove all active JavaScript breakpoints on the current page.

**Parameters:** None

### step_into

Step into a function call at the current line.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `maxCallStackDepth` | number | No | Max call stack frames to display. Default: 4 |
| `contextLines` | number | No | Lines of code context. Default: 2 |
| `maxLocalVariables` | number | No | Max local variables to display. Default: 5 |
| `showStatus` | boolean | No | Show status after step. Default: true |

### step_over

Step over to the next line of code without stepping into function calls.

**Parameters:** Same as `step_into`

### step_out

Step out of the current function to return to the caller.

**Parameters:** Same as `step_into`

### resume_execution

Resume JavaScript execution after hitting a breakpoint.

**Parameters:** None

### get_debugger_status

Get the current status of the JavaScript debugger including call stack, code context, and scope variables.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `frameIndex` | number | No | Call frame index. Default: 0 |
| `contextLines` | number | No | Lines of code context. Default: 5 |
| `maxPropertiesPerScope` | number | No | Max properties per scope |
| `skipScopeVariables` | boolean | No | Skip scope variable inspection |
| `useObjectPreviews` | boolean | No | Use object previews instead of full retrieval |
| `maxOutputLines` | number | No | Max output lines. Default: 100 |
| `maxCallStackFrames` | number | No | Max call stack frames. Default: 20 |
| `maxLineLength` | number | No | Max line length. Default: 500 |

### evaluate_script

Evaluate JavaScript code inside the currently selected page.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `script` | string | Yes | JavaScript code to execute |
| `maxOutputChars` | number | No | Max output characters. Default: 10000 |

### evaluate_on_call_frame

Evaluate a JavaScript expression in the context of a specific call frame when paused.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `expression` | string | Yes | JavaScript expression to evaluate |
| `frameIndex` | number | No | Call frame index. Default: 0 |
| `maxOutputChars` | number | No | Max output characters. Default: 10000 |
| `filepath` | string | No | Save result to file instead of displaying |

### get_scope_variables

Get detailed variable information from a specific scope when paused.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `frameIndex` | number | No | Call frame index. Default: 0 |
| `scopeType` | enum | No | Filter by scope type: `local`, `closure`, `block`, `script`, `global`, etc. |
| `variableName` | string | No | Get a specific variable |
| `searchTerm` | string | No | Filter variables by name |
| `pageSize` | number | No | Variables per page |
| `pageIdx` | number | No | Page number (0-based) |
| `maxDepth` | number | No | Max depth for nested objects. Default: 3 |
| `maxOutputLines` | number | No | Max output lines. Default: 100 |
| `saveToFile` | string | No | Save full output to file |
| `maxLineLength` | number | No | Max line length. Default: 1000 |

### save_scope_variables

Save all scope variables from the current debug context to a JSON file.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `filePath` | string | Yes | File path to save JSON |
| `frameIndex` | number | No | Call frame index. Default: 0 |
| `includeGlobal` | boolean | No | Include global scope. Default: false |

### get_possible_breakpoints

Discover all valid breakpoint locations in a script at a specific line.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `urlRegex` | string | Yes | URL pattern to match scripts |
| `lineNumber` | number | Yes | Line number (1-based) |
| `startColumn` | number | No | Start column for search range |
| `endColumn` | number | No | End column for search range |
| `maxCount` | number | No | Max locations to return. Default: 20 |

### disable_debugger

Disable the JavaScript debugger on the current page and remove all breakpoints.

**Parameters:** None

### set_xhr_breakpoint

Set an XHR/Fetch breakpoint that pauses execution when a request URL contains the specified substring.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `urlPattern` | string | Yes | URL substring to match. Empty string matches all requests |

### remove_xhr_breakpoint

Remove a previously set XHR/Fetch breakpoint.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `urlPattern` | string | No | URL pattern to remove. If omitted, removes all XHR breakpoints |

### list_xhr_breakpoints

List all active XHR/Fetch breakpoints.

**Parameters:** None

---

## Script Analysis

### save_script_source

Save a script source to a local file.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pattern` | string | Yes | Pattern to match script. Use "VM123" for scriptId, otherwise matches by URL substring |
| `filePath` | string | Yes | Path to save the script file |

### analyze_call_graph

Analyze the call graph for a specific JavaScript function.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `functionName` | string | Yes | Name of the function to analyze |
| `upstreamDepth` | number | No | Max depth for callers. Default: 3, Max: 10 |
| `downstreamDepth` | number | No | Max depth for callees. Default: 3, Max: 10 |
| `urlPattern` | string | No | Regex pattern to filter scripts by URL |

---

## Script Interception

### replace_script

Replace a JavaScript code snippet in scripts matching a URL pattern.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `urlPattern` | string | Yes | URL pattern (regex) to match scripts |
| `oldCode` | string | Yes | Original code snippet to replace |
| `newCode` | string | Yes | New code snippet |

**Note:** Changes take effect after page refresh. Rules persist across refreshes until removed.

### list_script_replacements

List all active script replacement rules for the current page.

**Parameters:** None

### remove_script_replacement

Remove a script replacement rule by its ID.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `ruleId` | string | Yes | The rule ID to remove |

### clear_script_replacements

Remove all script replacement rules for the current page.

**Parameters:** None

---

## Console

### list_console_messages

List all console messages for the currently selected page.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pageSize` | number | No | Max messages to return |
| `pageIdx` | number | No | Page number (0-based) |
| `types` | array | No | Filter by message types: `log`, `debug`, `info`, `error`, `warn`, `issue`, etc. |
| `includePreservedMessages` | boolean | No | Include preserved messages over last 3 navigations |
| `savePath` | string | No | File path to save console messages |
| `maxLineLength` | number | No | Max length per message line. Default: 500 |

### get_console_message

Get a specific console message by its ID.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `msgid` | number | Yes | The msgid of the console message |

---

## Screenshots & Snapshots

### take_screenshot

Take a screenshot of the page or element.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `format` | enum | No | Format: `png`, `jpeg`, `webp`. Default: `png` |
| `quality` | number | No | Compression quality (0-100) for JPEG/WebP |
| `uid` | string | No | Element uid to screenshot. If omitted, screenshots the page |
| `fullPage` | boolean | No | Screenshot the full page instead of viewport |
| `filePath` | string | No | File path to save the screenshot |

### take_snapshot

Take a text snapshot of the currently selected page based on the accessibility tree.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `verbose` | boolean | No | Include all available information. Default: false |
| `filePath` | string | No | File path to save the snapshot |
| `search` | string | No | Filter elements matching this text (case-insensitive) |
| `pageSize` | number | No | Elements per page for pagination |
| `pageIdx` | number | No | Page index (0-based) |
