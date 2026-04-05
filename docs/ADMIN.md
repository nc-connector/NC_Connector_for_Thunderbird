# Administration Guide — NC Connector for Thunderbird

This document is for **administrators** who want to deploy and operate **NC Connector for Thunderbird** at scale.

It covers:
- A complete reference of the add-on’s settings
- How password policies are handled (Nextcloud-controlled)
- System-wide rollout via Thunderbird **Enterprise Policies** (ATN “latest” or GitHub “latest”)

Related docs:
- `docs/DEVELOPMENT.md` — developer/onboarding guide (message contracts, data model, flows)
- `docs/ATN_REVIEW_CHECKLIST_INTERNAL.md` — reviewer constraints (especially for experiments)

---

## Table of Contents

- [1. Supported versions & requirements](#1-supported-versions--requirements)
- [2. Add-on settings reference](#2-add-on-settings-reference)
  - [2.1 General (Nextcloud connection)](#21-general-nextcloud-connection)
  - [2.2 Sharing defaults](#22-sharing-defaults)
  - [2.3 Talk Link defaults](#23-talk-link-defaults)
  - [System address book required for user search and moderator selection](#system-address-book-required-for-user-search-and-moderator-selection)
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
  - [4.7 Attachment automation prerequisite: disable competing Thunderbird compose features](#47-attachment-automation-prerequisite-disable-competing-thunderbird-compose-features)
  - [4.8 Verifying policies & troubleshooting](#48-verifying-policies--troubleshooting)
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
| Base directory | `sharingBasePath` | Remote folder base path under which new share folders are created (e.g. `90 Shares - external`) |
| Default share name | `sharingDefaultShareName` | Pre-fills the share name input |
| Default permissions: Upload/Create | `sharingDefaultPermCreate` | Enables “upload/create” for the share |
| Default permissions: Edit | `sharingDefaultPermWrite` | Enables editing for the share |
| Default permissions: Delete | `sharingDefaultPermDelete` | Enables delete for the share |
| Default: set password | `sharingDefaultPassword` | Pre-enables the password toggle in the wizard |
| Default: send password in separate mail | `sharingDefaultPasswordSeparate` | Pre-enables the separate-password toggle in the wizard (only effective when password is enabled) |
| Expiration (days) | `sharingDefaultExpireDays` | Default expiration time for new shares |
| Always handle attachments via NC Connector | `sharingAttachmentsAlwaysConnector` | Immediately moves compose attachments into NC Connector share flow |
| Offer upload for files larger than | `sharingAttachmentsOfferAboveEnabled` | Enables threshold-based decision popup in compose |
| Threshold (MB) | `sharingAttachmentsOfferAboveMb` | Total attachment-size limit that triggers the popup |

Attachment behavior details:
- Threshold checks are based on **total compose attachment size** after each add action.
- If the threshold is exceeded, users can choose to:
  - share attachments via NC Connector, or
  - remove the most recently selected attachment batch.
- In attachment mode, the sharing wizard starts directly in file step and publishes a ZIP download link.
- In attachment mode, recipient permissions are enforced as read-only (independent of default permission toggles).

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

### 2.3.1 Optional NC Connector backend policies

If the optional Nextcloud backend app `ncc_backend_4mc` is installed, Thunderbird also evaluates:
- `/apps/ncc_backend_4mc/api/v1/status`

Runtime behavior:
- checked when Talk wizard opens
- checked when Sharing wizard opens
- checked when add-on settings open and when add-on settings are saved
- valid active seat => backend policy values apply and `policy_editable=false` fields are locked in the UI
- missing backend / no seat / invalid seat => local add-on settings remain active
- if the backend is unreachable, Thunderbird falls back to the locally saved add-on settings
- if the backend is reachable but the license/seat state is no longer usable, Thunderbird also falls back to the locally saved add-on settings
- invalid seat states remain visible in the UI so users can contact their administrator
- separate password delivery is only available when the backend endpoint exists and the current user has an active assigned seat
- separate password follow-up mails target only the primary mail `To` recipients
- automatic password follow-up send reuses the same Thunderbird sender identity as the primary mail
- if Thunderbird cannot resolve the sender identity cleanly, or if automatic send fails, the add-on opens a prefilled manual fallback draft instead of attempting an unsafe partial send
- once the primary mail was sent, password-follow-up problems never delete the committed share
- backend custom templates stay inactive until the corresponding language override is set to `custom`
- the `custom` option is only shown when the backend endpoint exists and stays disabled unless the effective backend policy for that domain is actually `custom` and provides a template
- if `custom` is selected but the backend template is empty or unavailable, Thunderbird falls back to the local UI-default text block
- `policy.talk.event_description_type` may be `html` or `plain_text`; when `html` is active, Thunderbird writes the Talk block into the rich event description editor as HTML and keeps a plain-text representation alongside it for non-HTML consumers

Central policy can currently control:
- Talk defaults and lock state
- Sharing defaults and lock state
- share HTML/password templates
- Talk description language / custom invitation template

### System address book required for user search and moderator selection

The following features require a reachable **Nextcloud system address book**:
- Talk wizard user search (internal users)
- Moderator selection in the Talk wizard
- "Add users" default in add-on settings
- "Add guests" default in add-on settings

If the system address book is unavailable, these controls are disabled in the UI and the tooltip links to this section.

Nextcloud 31 (server config via `occ`):
- `sudo -E -u www-data php occ config:app:set dav system_addressbook_exposed --value="yes"`

Nextcloud >= 32:
- Nextcloud -> Admin Settings -> Groupware -> System Address Book (enable it)

Required in both versions:
- Nextcloud Admin Settings -> Sharing: ensure username autocompletion / access to the system address book is enabled.
- Otherwise only the current user may appear in user search.

Repair hint (if Admin UI shows enabled but system address book is still effectively unavailable):

1. Recreate and sync the DAV flag via `occ`:
   - `sudo -E -u www-data php occ config:app:delete dav system_addressbook_exposed`
   - `sudo -E -u www-data php occ config:app:set dav system_addressbook_exposed --value="yes"`
   - `sudo -E -u www-data php occ dav:sync-system-addressbook`
2. Verify in a browser with an authenticated Nextcloud session:
   - `https://<cloud>/remote.php/dav/addressbooks/users/<user>/z-server-generated--system/?export`
3. If the endpoint is reachable again, reopen add-on settings or Talk wizard so NC Connector re-checks availability.

### 2.4 Advanced: language overrides

The add-on can override the language used for generated text blocks.

| UI label | Storage key | Purpose |
|---|---|---|
| Language in share block | `shareBlockLang` | Controls the language of the inserted sharing HTML block |
| Language in Talk description text | `eventDescriptionLang` | Controls the language of the Talk description block written into calendar events |

Values:
- `default` → use Thunderbird UI language
- `custom` → use the backend-provided template (option only shown when the NC Connector backend endpoint exists and only enabled when the effective backend policy for that domain is actually `custom` and provides a template)
- or a supported locale folder name (see `Translations.md`, e.g. `de`, `en`, `pt_BR`, `zh_TW`, …)

Important:
- `custom` only activates backend templates when the policy payload actually contains the respective template key.
- Empty/missing backend templates fall back to the local UI-default block.

### 2.5 Debug

| UI label | Storage key | Purpose |
|---|---|---|
| Debug logging | `debugEnabled` | Enables verbose diagnostic logs in the developer console |

When enabled, logs appear with prefixes such as:
- `[NCBG]` (background)
- `[NCUI][Talk]` (Talk wizard UI)
- `[NCUI][Sharing]` (Sharing wizard UI)
- `[ncCalToolbar]` (custom calendar editor toolbar/context bridge)
- `[calendar.items]` (persisted calendar monitoring logs)

### 2.6 About & Support

The “About” tab shows:
- current add-on version
- homepage link (`https://nc-connector.de`)
- license information (AGPL v3)
- technical overview text and a “More information” homepage link
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

### 4.7 Attachment automation prerequisite: disable competing Thunderbird compose features

If you want **NC Connector attachment automation** to be the only active compose flow, administrators should also disable Thunderbird’s own competing compose prompts centrally.

Why this is necessary:
- NC Connector can route attachments into its own sharing flow (`always` or `offer above threshold`).
- Thunderbird itself still has native compose features for:
  - **Check for missing attachments**
  - **Upload for files larger than ...**
- Per reviewer constraints and the add-on’s limited experiment scope, **NC Connector must not change these Thunderbird-wide compose settings itself**.
- Therefore, if you want a deterministic admin-managed rollout, disable and lock these Thunderbird settings via `policies.json`.

Relevant Thunderbird preferences:
- `mail.compose.attachment_reminder`
  - controls **Check for missing attachments**
- `mail.compose.big_attachments.notify`
  - controls **Upload for files larger than ...**
- `mail.compose.big_attachments.threshold_kb`
  - controls the native Thunderbird threshold value in **KB**

Recommended lock state when NC Connector attachment automation should own the workflow:
- `mail.compose.attachment_reminder` => `false` / `locked`
- `mail.compose.big_attachments.notify` => `false` / `locked`
- `mail.compose.big_attachments.threshold_kb` => `5120` / `locked`

Notes:
- `5120` KB is Thunderbird’s default threshold value (5 MB). Once `mail.compose.big_attachments.notify=false`, the threshold is effectively inactive, but keeping it explicitly locked avoids drift and makes the admin intent visible.
- Merge the example below into your existing `policies.json`; do not create a second policy file.

Official references:
- Thunderbird Enterprise Policies — `Preferences` policy:
  - `https://thunderbird.github.io/policy-templates/templates/esr140/#preferences`
- Thunderbird compose preferences source:
  - `https://searchfox.org/comm-central/source/mail/components/preferences/compose.inc.xhtml`

Example `policies.json` snippet:

```json
{
  "policies": {
    "Preferences": {
      "mail.compose.attachment_reminder": {
        "Value": false,
        "Status": "locked"
      },
      "mail.compose.big_attachments.notify": {
        "Value": false,
        "Status": "locked"
      },
      "mail.compose.big_attachments.threshold_kb": {
        "Value": 5120,
        "Status": "locked"
      }
    }
  }
}
```

Example merged `policies.json` (force-install NC Connector + lock Thunderbird native attachment prompts):

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
    },
    "Preferences": {
      "mail.compose.attachment_reminder": {
        "Value": false,
        "Status": "locked"
      },
      "mail.compose.big_attachments.notify": {
        "Value": false,
        "Status": "locked"
      },
      "mail.compose.big_attachments.threshold_kb": {
        "Value": 5120,
        "Status": "locked"
      }
    }
  }
}
```

Example Ansible task (Linux) that deploys both the add-on policy and the native compose locks:

```yaml
- name: Thunderbird - force install nc4tb and disable native attachment prompts
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

    - name: Deploy policies.json with nc4tb and locked native compose attachment prefs
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
              },
              "Preferences": {
                "mail.compose.attachment_reminder": {
                  "Value": false,
                  "Status": "locked"
                },
                "mail.compose.big_attachments.notify": {
                  "Value": false,
                  "Status": "locked"
                },
                "mail.compose.big_attachments.threshold_kb": {
                  "Value": 5120,
                  "Status": "locked"
                }
              }
            }
          }
```

### 4.8 Verifying policies & troubleshooting

Verification checklist:
1. Open `about:policies` in Thunderbird.
2. Ensure the policy file is detected and there are no JSON parse errors.
3. Restart Thunderbird and check:
   - Add-on is installed automatically
   - Updates are enabled (unless you intentionally disabled them)
   - Thunderbird’s own compose options for missing attachments / large-attachment upload are no longer user-changeable if you locked them

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


