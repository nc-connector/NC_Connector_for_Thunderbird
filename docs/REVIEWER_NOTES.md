# Reviewer Guidelines & Agreed Constraints
## NC Connector for Thunderbird

This document summarizes the fundamental reviewer requirements and constraints
communicated during the review process of this add-on.
It is intended to guide ongoing and future maintenance.

---

## 1. Experiment Scope & Quality

- Experiments have **full access to Thunderbird internals** and must therefore be:
  - minimal
  - deterministic
  - easy to audit
  - free of trial-and-error code

- The Experiment surface must be **kept as small as possible**.
- All control logic should live in the **WebExtension background** where feasible.

---

## 2. No Guessing / No Trial-and-Error Code

- Do **not** use `try { ... } catch {}` blocks to guess valid code paths.
- There must be **one clearly defined code path**.
- If multiple paths are required for compatibility:
  - Use **feature detection** or **version checks**
  - Add **explicit comments** indicating which Thunderbird version requires which path

- Any remaining `catch` blocks **must log the error**.

---

## 3. Globals & APIs

- Do **not** reassign or recreate global objects such as:
  - `Services`
  - `XPCOMUtils`
  - `ExtensionSupport`
- These are globally available in Experiment scripts and must be used directly.

---

## 4. Experiment Encapsulation

- Experiments must be **properly encapsulated per context**.
- Use the standard pattern:
  - `class <ExperimentName> { constructor(context) ... close() ... }`
  - `context.callOnClose(...)` for cleanup

- Avoid global state and static registries.

---

## 5. Window & Context Handling

- Do **not** store native windows in `Map()` or `Array()`.
- If tracking is required, use `WeakMap()` only.

- In most cases:
  - **Do not track windows at all**
  - Retrieve windows on demand using:
    ```js
    context.extension.windowManager.get(windowId).window
    ```
  - Or the inverse:
    ```js
    context.extension.windowManager.getWrapper(window).id
    ```

- Manual correlation between native windows and WebExtension IDs is unnecessary.

---

## 6. Window & Tab Observing

- Avoid scanning or monitoring *all* windows or tabs.
- Restrict listeners as much as possible:
  - Use `ExtensionSupport.registerWindowListener`
  - Limit to required `chromeURLs`

- For cleanup or global actions, use:
  ```js
  for (let window of ExtensionSupport.openWindows) { ... }
  ```

---

## 7. Calendar Integration

- Do **not** implement custom calendar monitoring in the Experiment.
- Use the **official Thunderbird Calendar Experiment** as-is.
- Do **not modify** the calendar experiment code.
- All calendar-related logic must live in the background using the provided API.

---

## 8. UI Targeting & Selectors

- UI elements must be accessed using **dedicated identifiers**.
- Do **not** rely on:
  - localized labels
  - placeholders
  - aria text
  - broad or heuristic selectors

- If multiple identifiers are required:
  - Clearly document which Thunderbird version requires which identifier.

---

## 9. Dialog vs Tab Editors

- Event editors may appear:
  - as a **dialog**
  - or as a **tab** (calendarEvent mode)

- Tab editors:
  - live inside the `mail:3pane` window
  - use an iframe (`calendar-item-iframe.xhtml`)
- The add-on must support both without duplicating logic or increasing Experiment scope.

---

## 10. Logging & Stability

- Errors must be logged.
- Silent failures are not acceptable.
- The add-on must not degrade Thunderbird stability, performance, or usability.

---

## 11. General Reviewer Expectations

- Code must be:
  - readable
  - well-commented
  - maintainable by third parties
- Experiments should look **planned**, not experimental.
- Avoid legacy or obsolete references (e.g. XUL in Thunderbird ≥ 128).

---

_Last updated based on reviewer feedback up to version 2.2.5._
