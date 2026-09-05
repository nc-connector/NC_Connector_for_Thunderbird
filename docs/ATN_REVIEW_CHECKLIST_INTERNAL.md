# Reviewer Guidelines & Agreed Constraints
## NC Connector for Thunderbird

This document summarizes the fundamental reviewer requirements and constraints
communicated during the review process of this add-on.
It is intended to guide ongoing and future maintenance.

---

## 1. Experiment Scope & Quality

- Experiments have **full access to Thunderbird internals** and must therefore be:
  - minimal
  - stable in behavior
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

## 11. Security Guards Must Fail Closed

- If a code path depends on a security mechanism, the absence of that mechanism
  must never cause a fallback to raw or untrusted input.
- For backend/remote HTML specifically:
  - sanitize before use
  - if the sanitizer is unavailable, return an empty value or throw
  - never keep a potential code path that forwards raw HTML into UI or privileged contexts
- Review lesson from the 3.0.1 rejection (John Bieling):
  - a fallback from “sanitizer unavailable” to raw HTML injection is itself a review blocker

---

## 12. General Reviewer Expectations

- Code must be:
  - readable
  - well-commented
  - maintainable by third parties
- Experiments should look **planned**, not experimental.
- Avoid legacy or obsolete references (e.g. XUL in Thunderbird ≥ 128).

---

## 13. VFS Integration Constraints

- Vendor the Thunderbird VFS Toolkit from one pinned upstream base plus explicitly documented upstream PR commits. Vendored runtime files must match that combined upstream source after LF normalization; do not carry NC Connector-specific functional or CSS patches.
- Keep VFS business logic in ordinary WebExtension/background modules; do not add an Experiment API for storage access.
- Use the existing NC Connector account as the sole Nextcloud credential owner. Never duplicate credentials in Toolkit connection or queue records.
- A provider grant must be explicit, revocable, bound to the verified runtime sender and exact storage ID, and invalidated when server or canonical user changes.
- Full provider read/write capabilities must be stated in the grant UI. External-provider discovery must remain disabled by default and behind Thunderbird's optional `management` permission.
- Collect and validate the complete mixed-source queue before the first upload mutation. Preserve folders and empty directories.
- Same-Nextcloud sources must use server-side copy and remain untouched. External sources may exist as one in-memory Toolkit `File` during transfer but must not be persisted or staged on disk.
- Cancellation and failures may clean only NC Connector's generated share root or partial provider mutations reported by the Toolkit contract. They must never delete or move a selected source.
- Do not add fallback transfer paths that hide protocol or provider failures.

_Last updated for the current development branch._
