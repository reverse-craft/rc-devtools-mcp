# ReverseCraft DevTools MCP

A powerful MCP (Model Context Protocol) server for browser debugging and reverse engineering. Provides AI coding assistants with comprehensive browser automation, JavaScript debugging, and network analysis capabilities.

## Features

- **JavaScript Debugging**: Set breakpoints, step through code, inspect variables, and analyze call graphs
- **IR Debugging**: Debug JSVMP-protected code at the IR (Intermediate Representation) level with source map support
- **Network Analysis**: Monitor, search, and save network requests with full request/response details
- **Script Interception**: Replace JavaScript code on-the-fly for testing and reverse engineering
- **Page Automation**: Navigate pages, interact with elements, and capture screenshots
- **Console Monitoring**: Access and filter console messages with full stack traces

## Installation

### Using npx (Recommended)

```bash
npx @reverse-craft/rc-devtools-mcp@latest
```

### Using npm

```bash
npm install -g @reverse-craft/rc-devtools-mcp
rc-devtools-mcp
```

## MCP Client Configuration

### Kiro

Add to your Kiro MCP configuration (`.kiro/settings/mcp.json`):

```json
{
  "mcpServers": {
    "rc-devtools": {
      "command": "npx",
      "args": ["@reverse-craft/rc-devtools-mcp@latest"]
    }
  }
}
```

### Cursor

Add to your Cursor MCP configuration:

```json
{
  "mcpServers": {
    "rc-devtools": {
      "command": "npx",
      "args": ["@reverse-craft/rc-devtools-mcp@latest"]
    }
  }
}
```

### Claude Desktop

Add to your Claude Desktop configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "rc-devtools": {
      "command": "npx",
      "args": ["@reverse-craft/rc-devtools-mcp@latest"]
    }
  }
}
```

### With Custom Options

```json
{
  "mcpServers": {
    "rc-devtools": {
      "command": "npx",
      "args": [
        "@reverse-craft/rc-devtools-mcp@latest",
        "--headless",
        "--viewport", "1920x1080"
      ]
    }
  }
}
```

## Quick Start

1. Configure your MCP client with the server
2. Start a conversation with your AI assistant
3. Ask it to navigate to a website and debug JavaScript:

```
Navigate to https://example.com and set a breakpoint on line 10 of main.js
```

Or analyze network traffic:

```
List all network requests and show me the API calls
```

## Available Tools

### Input Automation

**`click`** - Click on an element
- `uid` (string, required): Element uid from page content snapshot
- `dblClick` (boolean, optional): Set to true for double click (default: false)

**`fill`** - Type text into input or select option
- `uid` (string, required): Element uid from page content snapshot
- `value` (string, required): Text to fill or option to select

**`press_key`** - Press a key or key combination
- `key` (string, required): Key or combination (e.g., "Enter", "Control+A", "Control+Shift+R")
  - Supported modifiers: Control, Shift, Alt, Meta

### Navigation

**`navigate_page`** - Navigate to URL, go back/forward, or reload
- `type` (string, optional): Navigation type: `url`, `back`, `forward`, or `reload`
- `url` (string, optional): Target URL (required when type=url)
- `ignoreCache` (boolean, optional): Ignore cache on reload
- `enableDebugger` (boolean, optional): Enable JavaScript debugger after navigation (default: true)
- `timeout` (number, optional): Navigation timeout in milliseconds

**`new_page`** - Create a new browser page
- `url` (string, required): URL to load in the new page
- `incognito` (boolean, optional): Open in incognito window
- `newWindow` (boolean, optional): Open in new window
- `userDataDir` (string, optional): Independent user data directory path
- `enableDebugger` (boolean, optional): Enable JavaScript debugger (default: true)
- `timeout` (number, optional): Navigation timeout in milliseconds

**`close_page`** - Close a page by index
- `pageIdx` (number, required): Index of page to close (from `list_pages`)

**`list_pages`** - List all open pages
- No parameters

**`select_page`** - Select a page as active context
- `pageIdx` (number, required): Index of page to select (from `list_pages`)
- `bringToFront` (boolean, optional): Focus and bring page to top

**`clear_cookies`** - Clear browser cookies
- `url` (string, optional): Clear cookies for specific domain only (omit to clear all)

### Network

**`list_network_requests`** - List all network requests
- `pageSize` (number, optional): Maximum requests to return
- `pageIdx` (number, optional): Page number (0-based)
- `resourceTypes` (array, optional): Filter by resource types (e.g., `["xhr", "fetch", "script"]`)
- `includePreservedRequests` (boolean, optional): Include requests from last 3 navigations (default: false)

**`get_network_request`** - Get details of a specific request
- `reqid` (number, optional): Request ID (omit to use currently selected request in DevTools)

**`save_network_request`** - Save request/response to file in raw HTTP format
- `reqid` (number, optional): Request ID (omit to use currently selected request)
- `filePath` (string, required): File path to save HTTP transaction
- `responseBodyFilePath` (string, optional): Separate file for binary response body
- `saveRequestBody` (boolean, optional): Save request body to separate file
- `requestBodyFilePath` (string, optional): File path for request body

**`save_static_resource`** - Save static resource to file
- `reqid` (number, required): Request ID containing the resource
- `filePath` (string, required): File path or directory (extension auto-detected from content type)

### Debugging

#### Breakpoint Management

**`set_breakpoint`** - Set a JavaScript breakpoint at a specific line
- `urlRegex` (string, required): Regular expression to match script URL (e.g., `".*main\\.js.*"`)
- `lineNumber` (number, required): Line number (1-based, as shown in editors)
- `columnNumber` (number, optional): Target column number (0-based) for smart snapping
- `snapRange` (number, optional): Search range around target column for valid positions (default: 100)
- `condition` (string, optional): JavaScript expression - breakpoint only triggers when true

**`remove_breakpoint`** - Remove a breakpoint by its ID
- `breakpointId` (string, required): CDP breakpoint ID from `set_breakpoint` or `list_breakpoints`

**`list_breakpoints`** - List all active breakpoints
- `searchTerm` (string, optional): Filter breakpoints by ID or URL pattern
- `pageSize` (number, optional): Maximum breakpoints per page
- `pageIdx` (number, optional): Page number (0-based)

**`clear_all_breakpoints`** - Remove all breakpoints on the current page
- No parameters

**`get_possible_breakpoints`** - Find valid breakpoint locations (useful for minified code)
- `urlRegex` (string, required): Regular expression to match script URL
- `lineNumber` (number, required): Line number to search (1-based)
- `startColumn` (number, optional): Start column for search range (0-based)
- `endColumn` (number, optional): End column for search range (0-based)
- `maxCount` (number, optional): Maximum locations to return (default: 20)

#### Execution Control

**`step_into`** - Step into a function call
- `maxCallStackDepth` (number, optional): Max call stack frames to display (default: 4)
- `contextLines` (number, optional): Lines of code context before/after (default: 2)
- `maxLocalVariables` (number, optional): Max local variables to display (default: 5)
- `showStatus` (boolean, optional): Whether to show debug status (default: true)

**`step_over`** - Step over to the next line
- `maxCallStackDepth` (number, optional): Max call stack frames to display (default: 4)
- `contextLines` (number, optional): Lines of code context before/after (default: 2)
- `maxLocalVariables` (number, optional): Max local variables to display (default: 5)
- `showStatus` (boolean, optional): Whether to show debug status (default: true)

**`step_out`** - Step out of the current function
- `maxCallStackDepth` (number, optional): Max call stack frames to display (default: 4)
- `contextLines` (number, optional): Lines of code context before/after (default: 2)
- `maxLocalVariables` (number, optional): Max local variables to display (default: 5)
- `showStatus` (boolean, optional): Whether to show debug status (default: true)

**`resume_execution`** - Resume paused execution
- No parameters

#### Inspection & Evaluation

**`get_debugger_status`** - Get current debugger state with call stack and variables
- `frameIndex` (number, optional): Call frame index to inspect (default: 0)
- `contextLines` (number, optional): Lines of code context (default: 5)
- `maxPropertiesPerScope` (number, optional): Max properties per scope to display
- `skipScopeVariables` (boolean, optional): Skip scope variable inspection
- `useObjectPreviews` (boolean, optional): Use object previews instead of full retrieval
- `maxOutputLines` (number, optional): Maximum output lines (default: 100)
- `maxCallStackFrames` (number, optional): Max call stack frames (default: 20)
- `maxLineLength` (number, optional): Max characters per line (default: 500)
- `showIRContext` (boolean, optional): Show IR context if paused in JSVMP code (default: true)

**`evaluate_on_call_frame`** - Evaluate JavaScript expression in a specific call frame
- `expression` (string, required): JavaScript expression to evaluate
- `frameIndex` (number, optional): Call frame index (default: 0)
- `maxOutputChars` (number, optional): Max output characters (default: 10000)
- `filepath` (string, optional): Save result to file instead of displaying

**`get_scope_variables`** - Get detailed variable information from a scope
- `frameIndex` (number, optional): Call frame index (default: 0)
- `scopeType` (string, optional): Filter by scope type (`local`, `closure`, `block`, `script`, `global`, etc.)
- `variableName` (string, optional): Get specific variable by name
- `searchTerm` (string, optional): Search variables by name
- `pageSize` (number, optional): Max variables per page
- `pageIdx` (number, optional): Page number (0-based)
- `maxDepth` (number, optional): Max depth for nested objects (default: 3)
- `maxOutputLines` (number, optional): Max output lines (default: 100)
- `saveToFile` (string, optional): Save output to file path
- `maxLineLength` (number, optional): Max characters per line (default: 1000)

**`save_scope_variables`** - Save all scope variables to a JSON file
- `filePath` (string, required): Output file path
- `frameIndex` (number, optional): Call frame index (default: 0)
- `includeGlobal` (boolean, optional): Include global scope (default: false)

**`disable_debugger`** - Disable the debugger and remove all breakpoints
- No parameters

#### XHR/Fetch Breakpoints

**`set_xhr_breakpoint`** - Set a breakpoint on XHR/Fetch requests
- `urlPattern` (string, required): URL substring to match (empty string matches all requests)

**`remove_xhr_breakpoint`** - Remove an XHR breakpoint
- `urlPattern` (string, optional): URL pattern to remove (omit to remove all XHR breakpoints)

**`list_xhr_breakpoints`** - List all active XHR breakpoints
- No parameters

### Script Analysis

**`save_script_source`** - Save script source code to file
- `scriptId` (string, optional): Script ID (omit to use currently selected script in DevTools)
- `filePath` (string, required): File path to save the source code

**`analyze_call_graph`** - Analyze function callers and callees
- `functionName` (string, required): Name of the function to analyze
- `upstreamDepth` (number, optional): Max depth for upstream trace (callers, default: 3, max: 10)
- `downstreamDepth` (number, optional): Max depth for downstream trace (callees, default: 3, max: 10)
- `urlPattern` (string, optional): Regex pattern to filter scripts by URL

**`search_functions`** - Search for functions by name pattern
- `pattern` (string, required): Function name pattern (substring or regex)
- `urlPattern` (string, optional): Regex pattern to filter scripts by URL
- `maxResults` (number, optional): Maximum results to return (default: 50)

### Script Interception

**`replace_script`** - Replace code in scripts matching a URL pattern
- `urlPattern` (string, required): Regex to match script URLs (e.g., `".*main\\.js.*"`)
- `oldCode` (string, required): Original code snippet to replace (must match exactly)
- `newCode` (string, required): New code snippet
- **Note:** Changes take effect after page refresh. Rules persist across refreshes.

**`list_script_replacements`** - List active script replacement rules
- No parameters

**`remove_script_replacement`** - Remove a script replacement rule
- `ruleId` (string, required): Rule ID to remove (from `list_script_replacements`)

**`clear_script_replacements`** - Remove all script replacement rules
- No parameters

### Console

**`list_console_messages`** - List console messages
- `pageSize` (number, optional): Maximum messages to return
- `pageIdx` (number, optional): Page number (0-based)
- `types` (array, optional): Filter by message types (e.g., `["log", "error", "warn"]`)
  - Available types: `log`, `debug`, `info`, `error`, `warn`, `dir`, `dirxml`, `table`, `trace`, `clear`, `assert`, `issue`, etc.
- `includePreservedMessages` (boolean, optional): Include messages from last 3 navigations (default: false)
- `savePath` (string, optional): Save messages to file instead of displaying
- `maxLineLength` (number, optional): Max characters per line (default: 500)

**`get_console_message`** - Get a specific console message by ID
- `msgid` (number, required): Message ID from `list_console_messages`

### Screenshots & Snapshots

**`take_screenshot`** - Capture a screenshot
- `format` (string, optional): Image format: `png`, `jpeg`, or `webp` (default: `png`)
- `quality` (number, optional): Compression quality for JPEG/WebP (0-100, higher = better quality)
- `uid` (string, optional): Element uid to screenshot (omit for full page)
- `fullPage` (boolean, optional): Capture full page instead of viewport (incompatible with uid)
- `filePath` (string, optional): Save to file instead of attaching to response

**`take_snapshot`** - Take a text snapshot of the page
- No parameters
- Returns accessibility tree representation of the page

## Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `--cdp-url` | CDP URL to connect to a running Chrome instance | `http://127.0.0.1:9222` |
| `--browser-url` | Connect to a debuggable Chrome instance | - |
| `--ws-endpoint` | WebSocket endpoint for Chrome connection | - |
| `--headless` | Run Chrome in headless mode | `false` |
| `--executable-path` | Path to custom Chrome executable | - |
| `--viewport` | Initial viewport size (e.g., `1280x720`) | - |
| `--user-data-dir` | Chrome user data directory | - |
| `--channel` | Chrome channel (`stable`, `beta`, `dev`, `canary`) | `stable` |
| `--isolated` | Use temporary user data directory | `false` |
| `--no-sandbox` | Disable Chrome sandboxes (for Docker) | `false` |
| `--proxy-server` | Proxy server configuration | - |
| `--proxy-username` | Proxy authentication username | - |
| `--proxy-password` | Proxy authentication password | - |
| `--log-file` | Path to save debug logs | - |
| `--no-category-emulation` | Disable emulation tools | - |
| `--no-category-network` | Disable network tools | - |

### Examples

Connect to an existing Chrome instance:
```bash
npx @reverse-craft/rc-devtools-mcp@latest --browser-url http://127.0.0.1:9222
```

Run in headless mode:
```bash
npx @reverse-craft/rc-devtools-mcp@latest --headless
```

Use Chrome Canary:
```bash
npx @reverse-craft/rc-devtools-mcp@latest --channel canary
```

Set viewport size:
```bash
npx @reverse-craft/rc-devtools-mcp@latest --viewport 1920x1080
```

Use with proxy:
```bash
npx @reverse-craft/rc-devtools-mcp@latest --proxy-server http://proxy.example.com:8080
```

## Requirements

- Node.js 20.19.0+, 22.12.0+, or 23+
- Chrome/Chromium browser (automatically managed or custom installation)

## License

Apache-2.0
