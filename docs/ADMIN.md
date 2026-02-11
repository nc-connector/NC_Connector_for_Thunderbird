# Administration Guide — NC Connector for Thunderbird

This document is for **administrators** who want to deploy and operate **NC Connector for Thunderbird** at scale.

It covers:
- A complete reference of the add-on’s settings
- How password policies are handled (Nextcloud-controlled)
- System-wide rollout via Thunderbird **Enterprise Policies** (ATN “latest” or GitHub “latest”)

Related docs:
- `docs/DEVELOPMENT.md` — developer/onboarding guide (message contracts, data model, flows)
- `docs/REVIEWER_NOTES.md` — reviewer constraints (especially for experiments)

---

## Table of Contents

- [1. Supported versions & requirements](#1-supported-versions--requirements)
- [2. Add-on settings reference](#2-add-on-settings-reference)
  - [2.1 General (Nextcloud connection)](#21-general-nextcloud-connection)
  - [2.2 Sharing defaults](#22-sharing-defaults)
  - [2.3 Talk Link defaults](#23-talk-link-defaults)
  - [2.4 Advanced: language overrides](#24-advanced-language-overrides)
  - [2.5 Debug](#25-debug)
  - [2.6 About & Support](#26-about--support)
- [3. Password policy behavior (Nextcloud-controlled)](#3-password-policy-behavior-nextcloud-controlled)
  - [3.1 What the policy does (and does not do)](#31-what-the-policy-does-and-does-not-do)
  - [3.2 Where the policy is read from](#32-where-the-policy-is-read-from)
  - [3.3 Password generation and validation](#33-password-generation-and-validation)
- [4. System-wide deployment via Thunderbird policies.json](#4-system-wide-deployment-via-thunderbird-policiesjson)
  - [4.1 Add-on ID (GUID)](#41-add-on-id-guid)
  - [4.2 Policy locations (Windows/macOS/Linux)](#42-policy-locations-windowsmacoslinux)
  - [4.3 Rollout option A: ATN (recommended, signed, “always latest”)](#43-rollout-option-a-atn-recommended-signed-always-latest)
  - [4.4 Rollout option B: GitHub Releases (“always latest”)](#44-rollout-option-b-github-releases-always-latest)
  - [4.5 Example policies.json](#45-example-policiesjson)
  - [4.6 Example Ansible task (Linux)](#46-example-ansible-task-linux)
  - [4.7 Verifying policies & troubleshooting](#47-verifying-policies--troubleshooting)
- [5. Notes about “system-wide configuration”](#5-notes-about-system-wide-configuration)

---

## 1. Supported versions & requirements

Thunderbird:
- Target: **Thunderbird ESR 140.\***  
  Enforced by `manifest.json` (`strict_min_version: 140.0`, `strict_max_version: 140.*`).

Nextcloud:
- A Nextcloud instance with:
  - Talk installed
  - OCS endpoints reachable
  - Files sharing + DAV enabled

Network:
- The add-on needs host access to your Nextcloud origin for:
  - Talk OCS calls
  - Files sharing OCS calls
  - DAV operations (uploads / folder creation)
  - Capabilities (password policy)

---

## 2. Add-on settings reference

All settings are configured in Thunderbird via:
Add-ons Manager → NC Connector for Thunderbird → **Preferences / Options**

### 2.1 General (Nextcloud connection)

| UI label | Storage key | Purpose |
|---|---|---|
| Nextcloud URL | `baseUrl` | Base URL of your Nextcloud instance, e.g. `https://cloud.example.com` |
| Authentication mode | `authMode` | Manual (`manual`) or Login Flow v2 (`loginFlow`) |
| Username | `user` | Nextcloud login name |
| App password | `appPass` | App password used for OCS/DAV Basic auth |
| Login with Nextcloud… | (writes `user`/`appPass`) | Starts **Login Flow v2** and stores the returned app password |
| Test connection | (no key) | Validates credentials + origin permission + server reachability |

Operational notes:
- If you use Login Flow v2, the add-on obtains an app password from Nextcloud automatically.
- If the add-on cannot reach your Nextcloud origin, you will typically see permission errors or HTTP errors in the debug logs.

### 2.2 Sharing defaults

These defaults are used by the **Sharing Wizard** (compose window).

| UI label | Storage key | Purpose |
|---|---|---|
| Base directory | `sharingBasePath` | Remote folder base path under which new share folders are created (e.g. `90 Freigaben - extern`) |
| Default share name | `sharingDefaultShareName` | Pre-fills the share name input |
| Default permissions: Upload/Create | `sharingDefaultPermCreate` | Enables “upload/create” for the share |
| Default permissions: Edit | `sharingDefaultPermWrite` | Enables editing for the share |
| Default permissions: Delete | `sharingDefaultPermDelete` | Enables delete for the share |
| Default: set password | `sharingDefaultPassword` | Pre-enables the password toggle in the wizard |
| Expiration (days) | `sharingDefaultExpireDays` | Default expiration time for new shares |

### 2.3 Talk Link defaults

These defaults are used by the **Talk Wizard** (calendar event editor).

| UI label | Storage key | Purpose |
|---|---|---|
| Title | `talkDefaultTitle` | Default room title (pre-fills the wizard title) |
| Lobby until start time | `talkDefaultLobby` | Enables lobby scheduling by default |
| Listable (“In search”) | `talkDefaultListable` | Makes the room searchable in Talk by default |
| Add users | `talkAddUsersDefaultEnabled` | After the event is saved, internal Nextcloud users from invitees are added to the room |
| Add guests | `talkAddGuestsDefaultEnabled` | After the event is saved, external e-mail invitees are invited as guests |
| Set password | `talkPasswordDefaultEnabled` | Pre-enables the password toggle in the wizard |
| Room type | `talkDefaultRoomType` | `event` (Event conversation) or `normal` (Group conversation) |

Important behavior details:
- **Invitee sync happens after saving the event**, driven by calendar item updates (not immediately when clicking the toolbar button).
- “Guests” may trigger **additional invitation e-mails** from Nextcloud depending on server configuration and Talk version.

### 2.4 Advanced: language overrides

The add-on can override the language used for generated text blocks.

| UI label | Storage key | Purpose |
|---|---|---|
| Language in share block | `shareBlockLang` | Controls the language of the inserted sharing HTML block |
| Language in Talk description text | `eventDescriptionLang` | Controls the language of the Talk description block written into calendar events |

Values:
- `default` → use Thunderbird UI language
- or a supported locale folder name (see `Translations.md`, e.g. `de`, `en`, `pt_BR`, `zh_TW`, …)

### 2.5 Debug

| UI label | Storage key | Purpose |
|---|---|---|
| Debug logging | `debugEnabled` | Enables verbose diagnostic logs in the developer console |

When enabled, logs appear with prefixes such as:
- `[NCBG]` (background)
- `[NCUI][Talk]` (Talk wizard UI)
- `[NCUI][Sharing]` (Sharing wizard UI)
- `[NCCalToolbar]` (calendar editor toolbar experiment)

### 2.6 About & Support

The “About” tab shows:
- current add-on version
- license information (AGPL v3)
- donation link

---

## 3. Password policy behavior (Nextcloud-controlled)

### 3.1 What the policy does (and does not do)

Key rule:
- Nextcloud password policies define **password structure requirements** (e.g. minimum length), **not whether a password is required**.

In this add-on:
- Users can always create Talk rooms and shares **with or without a password**.
- If “Set password” is enabled, the add-on tries to generate/validate passwords according to the server policy.

### 3.2 Where the policy is read from

The add-on reads the policy from Nextcloud **capabilities**:
- `GET /ocs/v2.php/cloud/capabilities?format=json`

The relevant capabilities field is:
- `capabilities.password_policy`

If a server-side generator is available, it provides:
- `/ocs/v2.php/apps/password_policy/api/v1/generate`

### 3.3 Password generation and validation

If the user enables “Set password”:
1. The add-on fetches the current policy (min length, generator endpoint if available).
2. If a generator endpoint exists, it is used to generate a password server-side.
3. If not, the add-on falls back to a strong local generator.

If the user disables “Set password”:
- No password is generated or set, regardless of policy presence.

---

## 4. System-wide deployment via Thunderbird policies.json

Thunderbird supports enterprise policies via a `policies.json`. One policy can:
- Force-install the add-on for all users/profiles
- Keep updates enabled
- Prevent users from removing the add-on (depending on policy)

### 4.1 Add-on ID (GUID)

The add-on ID is:
- `{4a35421f-0906-439c-bff2-8eef39e2baee}`

This must match `browser_specific_settings.gecko.id` in the add-on’s `manifest.json`.

### 4.2 Policy locations (Windows/macOS/Linux)

Depending on OS and packaging, `policies.json` is typically placed under the Thunderbird **distribution** directory.

Common locations:
- **Windows:** `C:\\Program Files\\Mozilla Thunderbird\\distribution\\policies.json`
- **macOS:** `/Applications/Thunderbird.app/Contents/Resources/distribution/policies.json`
- **Linux (classic packages):** `/usr/lib/thunderbird/distribution/policies.json` (path may vary: `/usr/lib64/...`, `/opt/...`)

Tip:
- Use `about:policies` in Thunderbird to verify that the policy file is detected and parsed.

### 4.3 Rollout option A: ATN (recommended, signed, “always latest”)

ATN listing (for humans):
- `https://addons.thunderbird.net/de/thunderbird/addon/nc4tb/`

Direct “latest” download URL (for policies.json):
- `https://services.addons.thunderbird.net/thunderbird/downloads/latest/nc4tb/addon-989342-latest.xpi`

Benefits:
- “Always latest” without changing your policy file
- Uses the official ATN distribution channel (signed XPI)

### 4.4 Rollout option B: GitHub Releases (“always latest”)

Repository:
- `https://github.com/nc-connector/NC_Connector_for_Thunderbird`

If you want to force-install from GitHub, you need a **stable download URL** that always points to the latest release.

Recommended pattern:
- Use GitHub’s “latest release” redirect:
  - `https://github.com/nc-connector/NC_Connector_for_Thunderbird/releases/latest/download/nc4tb-latest.xpi`

Important:
- The asset name must be **the same in every release** (constant file name).
- Practical approach: upload an additional release asset named:
  - `nc4tb-latest.xpi`
  alongside the versioned asset (e.g. `nc4tb-2.2.7.xpi`), ideally automated via GitHub Actions.

Note about signing:
- In production environments, prefer ATN (signed). A self-hosted XPI may require signing depending on your Thunderbird build and deployment constraints.

### 4.5 Example policies.json

Example policy that force-installs NC Connector and keeps updates enabled:

```json
{
  "policies": {
    "ExtensionSettings": {
      "*": {
        "installation_mode": "allowed"
      },
      "{4a35421f-0906-439c-bff2-8eef39e2baee}": {
        "installation_mode": "force_installed",
        "install_url": "https://services.addons.thunderbird.net/thunderbird/downloads/latest/nc4tb/addon-989342-latest.xpi",
        "updates_disabled": false
      }
    }
  }
}
```

### 4.6 Example Ansible task (Linux)

Your snippet is structurally correct, but remove the stray trailing quote (`"`) after the JSON.
Here is a cleaned-up example:

```yaml
- name: Thunderbird - force install nc4tb (always latest) via policies.json
  hosts: all
  become: true

  vars:
    tb_distribution_dir: "/usr/lib/thunderbird/distribution"
    addon_guid: "{4a35421f-0906-439c-bff2-8eef39e2baee}"
    nc4tb_latest_url: "https://services.addons.thunderbird.net/thunderbird/downloads/latest/nc4tb/addon-989342-latest.xpi"

  tasks:
    - name: Ensure Thunderbird distribution directory exists
      ansible.builtin.file:
        path: "{{ tb_distribution_dir }}"
        state: directory
        mode: "0755"

    - name: Deploy policies.json (force_installed + keep updates enabled)
      ansible.builtin.copy:
        dest: "{{ tb_distribution_dir }}/policies.json"
        mode: "0644"
        content: |
          {
            "policies": {
              "ExtensionSettings": {
                "*": {
                  "installation_mode": "allowed"
                },
                "{{ addon_guid }}": {
                  "installation_mode": "force_installed",
                  "install_url": "{{ nc4tb_latest_url }}",
                  "updates_disabled": false
                }
              }
            }
          }
```

### 4.7 Verifying policies & troubleshooting

Verification checklist:
1. Open `about:policies` in Thunderbird.
2. Ensure the policy file is detected and there are no JSON parse errors.
3. Restart Thunderbird and check:
   - Add-on is installed automatically
   - Updates are enabled (unless you intentionally disabled them)

Common issues:
- **Wrong path:** policy file is not read → `about:policies` shows nothing.
- **JSON syntax error:** extension won’t install; `about:policies` shows parse errors.
- **Install URL unreachable:** network/proxy/firewall issue.

---

## 5. Notes about “system-wide configuration”

Enterprise Policies can reliably handle **system-wide installation**.

However, the add-on’s functional configuration (Nextcloud URL, credentials, defaults) currently lives in:
- `browser.storage.local` (per profile)

If you need “preseeded” settings for many users, typical approaches are:
- distribute a pre-configured Thunderbird profile
- use a central onboarding guide and require users to complete Login Flow v2

(A future enhancement could use `browser.storage.managed` to read admin-provided settings, but this is not implemented currently.)
