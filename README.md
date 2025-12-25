# ReverseCraft DevTools MCP

A powerful MCP (Model Context Protocol) server for browser debugging and reverse engineering. Provides AI coding assistants with comprehensive browser automation, JavaScript debugging, and network analysis capabilities.

## Features

- **JavaScript Debugging**: Set breakpoints, step through code, inspect variables, and analyze call graphs
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

| Tool | Description |
|------|-------------|
| `click` | Click on an element by its uid |
| `fill` | Type text into an input field or select an option |
| `press_key` | Press a key or key combination |

### Navigation

| Tool | Description |
|------|-------------|
| `navigate_page` | Navigate to a URL, go back/forward, or reload |
| `new_page` | Create a new browser page |
| `close_page` | Close a page by index |
| `list_pages` | List all open pages |
| `select_page` | Select a page as the active context |
| `clear_cookies` | Clear browser cookies |

### Network

| Tool | Description |
|------|-------------|
| `list_network_requests` | List all network requests |
| `get_network_request` | Get details of a specific request |
| `search_network_requests` | Search requests by URL, method, status, or content |
| `save_network_request` | Save a request/response to a file |
| `save_static_resource` | Save a static resource (JS, CSS, images) to a file |

### Debugging

| Tool | Description |
|------|-------------|
| `set_breakpoint` | Set a JavaScript breakpoint |
| `remove_breakpoint` | Remove a breakpoint by ID |
| `list_breakpoints` | List all active breakpoints |
| `clear_all_breakpoints` | Remove all breakpoints |
| `step_into` | Step into a function call |
| `step_over` | Step over to the next line |
| `step_out` | Step out of the current function |
| `resume_execution` | Resume paused execution |
| `get_debugger_status` | Get current debugger state with call stack and variables |
| `evaluate_script` | Execute JavaScript in the page context |
| `evaluate_on_call_frame` | Evaluate expression in a specific call frame |
| `get_scope_variables` | Get detailed variable information from a scope |
| `save_scope_variables` | Save scope variables to a JSON file |
| `get_possible_breakpoints` | Find valid breakpoint locations (useful for minified code) |
| `disable_debugger` | Disable the debugger |
| `set_xhr_breakpoint` | Set a breakpoint on XHR/Fetch requests |
| `remove_xhr_breakpoint` | Remove an XHR breakpoint |
| `list_xhr_breakpoints` | List all XHR breakpoints |

### Script Analysis

| Tool | Description |
|------|-------------|
| `save_script_source` | Save a script's source code to a file |
| `analyze_call_graph` | Analyze function callers and callees |
| `search_functions` | Search for functions by name pattern |

### Script Interception

| Tool | Description |
|------|-------------|
| `replace_script` | Replace code in scripts matching a URL pattern |
| `list_script_replacements` | List active script replacement rules |
| `remove_script_replacement` | Remove a script replacement rule |
| `clear_script_replacements` | Remove all script replacement rules |

### Console

| Tool | Description |
|------|-------------|
| `list_console_messages` | List console messages |
| `get_console_message` | Get a specific console message by ID |

### Screenshots & Snapshots

| Tool | Description |
|------|-------------|
| `take_screenshot` | Capture a screenshot of the page or element |
| `take_snapshot` | Take a text snapshot of the page (accessibility tree) |

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
