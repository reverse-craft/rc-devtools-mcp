# Navigation with Debugger Breakpoints Fix

## Problem

When `new_page` or `navigate_page` tools were used with debugger enabled and a breakpoint was triggered during page load, the MCP server would hang and eventually timeout. This happened because:

1. **SmartNavigator** correctly detected the debugger pause and returned `status: 'paused'`
2. However, the outer `waitForEventsAfterAction()` wrapper was still waiting for page load completion
3. Since the debugger was paused, the page load event never fired
4. This caused the operation to hang until MCP timeout

## Root Cause

The issue was a **double-waiting mechanism conflict**:

```typescript
// BEFORE (problematic code)
await context.waitForEventsAfterAction(async () => {
  result = await navigator.navigateToUrl(request.params.url, {
    timeout: request.params.timeout,
    debuggerEnabled: request.params.enableDebugger !== false,
  });
});
```

- `SmartNavigator.navigateToUrl()` uses `smartNavigate()` which implements a Promise.race pattern
- It correctly returns when either:
  - Page loads (`Page.loadEventFired` event)
  - Debugger pauses (`Debugger.paused` event)
  - Timeout occurs
- But `waitForEventsAfterAction()` from `WaitForHelper` waits for:
  - Navigation to complete
  - DOM to stabilize
- It doesn't know about debugger pauses, so it keeps waiting

## Solution

Remove the `waitForEventsAfterAction()` wrapper since `SmartNavigator` already handles all necessary waiting logic:

```typescript
// AFTER (fixed code)
const navigator = new SmartNavigator(page);
const result = await navigator.navigateToUrl(request.params.url, {
  timeout: request.params.timeout,
  debuggerEnabled: request.params.enableDebugger !== false,
});
```

## Changes Made

### Files Modified

1. **src/tools/pages.ts**
   - `newPage` handler: Removed `waitForEventsAfterAction()` wrapper
   - `navigatePage` handler: Removed `waitForEventsAfterAction()` wrapper for all navigation types:
     - URL navigation
     - Back navigation
     - Forward navigation
     - Reload

### Why This Works

`SmartNavigator` already implements proper waiting logic:

1. **smartNavigate()** function uses Promise.race to handle multiple outcomes:
   ```typescript
   return new Promise(resolve => {
     // Setup listeners BEFORE navigation
     if (shouldListenForPause) {
       session.on('Debugger.paused', onPaused);
     }
     session.on('Page.loadEventFired', onLoad);
     
     // Setup timeout
     timeoutId = setTimeout(() => {
       cleanup();
       resolve({ status: 'timeout', error: '...' });
     }, timeout);
     
     // Trigger navigation
     navigateAction().catch(error => {
       cleanup();
       resolve({ status: 'error', error: error.message });
     });
   });
   ```

2. When debugger pauses:
   - `onPaused` handler fires immediately
   - Returns `{ status: 'paused', callFrames: [...] }`
   - Cleanup removes all listeners
   - Control returns to caller

3. When page loads normally:
   - `onLoad` handler fires
   - Returns `{ status: 'loaded' }`
   - Cleanup removes all listeners
   - Control returns to caller

## Testing

All existing tests pass:
```bash
npm test
# ✔ tests 232
# ✔ pass 232
# ✔ fail 0
```

## Behavior After Fix

### Normal Navigation (No Breakpoint)
```
User: new_page with URL
→ SmartNavigator.navigateToUrl()
→ Page loads
→ Returns { status: 'loaded', url: '...' }
→ Response: "Successfully created new page and navigated to ..."
```

### Navigation with Breakpoint
```
User: new_page with URL (breakpoint set)
→ SmartNavigator.navigateToUrl()
→ Debugger pauses at breakpoint
→ Returns { status: 'paused', callFrames: [...] }
→ Response: "Created new page and navigated to ... Debugger is paused."
→ Response: "Paused at: functionName (file.js:123)"
```

### Navigation Timeout
```
User: new_page with URL (slow network)
→ SmartNavigator.navigateToUrl()
→ Timeout occurs
→ Returns { status: 'timeout', error: '...' }
→ Response: "Created new page but navigation to ... timed out: ..."
```

## Related Code

- **SmartNavigator**: `src/utils/smart-navigator.ts`
  - Implements debugger-aware navigation
  - Uses CDP primitives instead of Puppeteer's goto()
  - Handles race condition between page load and debugger pause

- **WaitForHelper**: `src/utils/wait-for-helper.ts`
  - General-purpose waiting utility
  - Not debugger-aware
  - Should only be used for non-navigation operations

## Conclusion

The fix eliminates the double-waiting mechanism by relying solely on `SmartNavigator`'s built-in waiting logic, which is already debugger-aware. This allows navigation operations to complete immediately when the debugger pauses, preventing MCP timeouts.
