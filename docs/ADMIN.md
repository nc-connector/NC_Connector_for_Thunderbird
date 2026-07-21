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
  - [1.1 Nextcloud Pretty URLs](#11-nextcloud-pretty-urls)
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
  - [4.5.1 Managed Nextcloud URL](#451-managed-nextcloud-url)
  - [4.6 Example Ansible task (Linux)](#46-example-ansible-task-linux)
  - [4.7 Attachment automation prerequisite: disable competing Thunderbird compose features](#47-attachment-automation-prerequisite-disable-competing-thunderbird-compose-features)
  - [4.8 Verifying policies & troubleshooting](#48-verifying-policies--troubleshooting)
- [5. Notes about “system-wide configuration”](#5-notes-about-system-wide-configuration)

---

## 1. Supported versions & requirements

Thunderbird:
- Target: **Thunderbird ESR 140.x through 153.x**
  Enforced by `manifest.json` (`strict_min_version: 140.0`, `strict_max_version: 153.*`).

Nextcloud:
- A Nextcloud instance with:
  - Talk installed
  - OCS endpoints reachable
  - Files sharing + DAV enabled
  - Nextcloud Secrets installed if you want Secrets-link password delivery

Network:
- The add-on needs host access to your Nextcloud origin for:
  - Talk OCS calls
  - Files sharing OCS calls
  - Secrets OCS calls when Secrets-link password delivery is enabled
  - DAV operations (uploads / folder creation)
  - Capabilities (password policy)

### 1.1 Nextcloud Pretty URLs

NC Connector uses Nextcloud for file sharing, uploads, authentication, Talk meetings, and optional services. Pretty URLs are a server-wide Nextcloud routing feature; they are not a setting for any one NC Connector function. One visible symptom of a broken rewrite is the public Talk link written to a calendar entry. For that link, NC Connector combines the configured public Nextcloud base URL with `/call/<TOKEN>`:

```text
https://cloud.example.com/call/<TOKEN>
```

If the same room works only with `/index.php/`, for example
`https://cloud.example.com/index.php/call/<TOKEN>`, the Nextcloud front-controller rewrite is missing or misconfigured. This is a web-server or reverse-proxy problem, not a Talk or NC Connector setting. Fix the public route instead of adding `/index.php` to the Nextcloud URL configured in NC Connector.

If Nextcloud is publicly available below a path such as `/nextcloud`, that path is part of the base URL. The expected room URL is then `https://cloud.example.com/nextcloud/call/<TOKEN>`.

#### Quick check

For an installation at the web root, open both URLs in a browser:

```text
https://cloud.example.com/index.php/login
https://cloud.example.com/login
```

For an installation below `/nextcloud`, use:

```text
https://cloud.example.com/nextcloud/index.php/login
https://cloud.example.com/nextcloud/login
```

The first URL is the baseline. The second URL must also reach Nextcloud or redirect to its login page instead of returning a web-server 404. If only the first URL works, Pretty URL rewriting is not working and `/call/<TOKEN>` links will fail for the same reason.

#### Nginx

Use Nextcloud's complete Nginx configuration as the baseline. The following blocks are only the relevant excerpts; merge them into the matching existing `server` and PHP/FastCGI locations rather than creating duplicate locations.

For Nextcloud at the web root, the request fallback must reach `index.php`:

```nginx
location / {
    try_files $uri $uri/ /index.php$request_uri;
}
```

The PHP/FastCGI location also needs:

```nginx
fastcgi_param front_controller_active true;
```

For Nextcloud below `/nextcloud`, the fallback inside Nextcloud's outer `location ^~ /nextcloud` block must include that path:

```nginx
location /nextcloud {
    try_files $uri $uri/ /nextcloud/index.php$request_uri;
}
```

Validate and reload Nginx after changing its configuration:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

#### Apache

Apache must load `mod_rewrite` and `mod_env`, and the `<Directory>` block for the Nextcloud installation must permit its `.htaccess` rules with `AllowOverride All`. On Debian or Ubuntu:

```bash
sudo a2enmod rewrite env
sudo systemctl reload apache2
```

Set the public CLI URL and the rewrite base in Nextcloud's `config/config.php`.

For Nextcloud at the web root:

```php
'overwrite.cli.url' => 'https://cloud.example.com/',
'htaccess.RewriteBase' => '/',
```

For Nextcloud below `/nextcloud`:

```php
'overwrite.cli.url' => 'https://cloud.example.com/nextcloud',
'htaccess.RewriteBase' => '/nextcloud',
```

Behind a reverse proxy, `htaccess.RewriteBase` is the path relative to the backend Apache `DocumentRoot`, after the proxy mapping. If the public proxy exposes `/nextcloud` but strips that prefix before forwarding to Apache, use `/`, not `/nextcloud`.

Regenerate Nextcloud's `.htaccess` as the web-server user, using the real installation path if it differs:

```bash
cd /var/www/nextcloud
sudo -E -u www-data php occ maintenance:update:htaccess
sudo systemctl reload apache2
```

Only if rewriting still fails after checking `mod_rewrite`, `AllowOverride All`, the rewrite base, and the regenerated `.htaccess`, add this fallback to `config/config.php`:

```php
'htaccess.IgnoreFrontController' => true,
```

Then run `maintenance:update:htaccess` again and reload Apache.

After the change, repeat the `/login` test and open a newly generated `/call/<TOKEN>` link from a client outside the server network. On managed hosting or appliances, apply the equivalent setting through the provider's supported web-server or reverse-proxy configuration.

Official Nextcloud references:

- [Nginx configuration](https://docs.nextcloud.com/server/stable/admin_manual/installation/nginx.html)
- [Apache installation and Pretty URLs](https://docs.nextcloud.com/server/stable/admin_manual/installation/source_installation.html#pretty-urls)
- [`maintenance:update:htaccess`](https://docs.nextcloud.com/server/stable/admin_manual/occ_system.html#maintenance-commands)

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
- Administrators can prefill or lock the Nextcloud URL through Thunderbird Enterprise Policy; user credentials still remain per user/profile.

### 2.2 Sharing defaults

These defaults are used by the **Sharing Wizard** (compose window).

| UI label | Storage key | Purpose |
|---|---|---|
| Base directory | `sharingBasePath` | Remote folder base path under which new share folders are created (e.g. `NC Connector`) |
| Default share name | `sharingDefaultShareName` | Pre-fills the share name input |
| Default permissions: Upload/Create | `sharingDefaultPermCreate` | Enables “upload/create” for the share |
| Default permissions: Edit | `sharingDefaultPermWrite` | Enables editing for the share |
| Default permissions: Delete | `sharingDefaultPermDelete` | Enables delete for the share |
| Default: set password | `sharingDefaultPassword` | Pre-enables the password toggle in the wizard |
| Default: send password in separate mail | `sharingDefaultPasswordSeparate` | Pre-enables the separate-password toggle in the wizard (only effective when password is enabled) |
| Default: password delivery | `sharingDefaultPasswordDeliveryMode` | `plain` sends the password as text; `secrets` sends a Nextcloud Secrets link when backend policy allows it |
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
| Delete Talk room when deleting a saved event | `talkDeleteRoomOnEventDelete` | Optional opt-in for deleting linked Talk rooms when a saved NC Connector event is deleted |
| Room type | `talkDefaultRoomType` | `event` (Event conversation) or `normal` (Group conversation) |

Important behavior details:
- **Invitee sync happens after saving the event**, driven by calendar item updates (not immediately when clicking the toolbar button).
- “Guests” may trigger **additional invitation e-mails** from Nextcloud depending on server configuration and Talk version.
- Deleting a saved calendar event deletes the linked Talk room only when this opt-in is enabled and the event has NC Connector `X-NCTALK-*` metadata. Generic Talk links in `LOCATION` or `URL` fields are ignored.
- Cleanup for rooms created in an unsaved and then discarded event editor remains active independently. A save attempt clears it only after Thunderbird reports a stored event with matching `X-NCTALK-TOKEN`.

### 2.3.1 Optional NC Connector backend policies

If the optional Nextcloud backend app `ncc_backend_4mc` is installed, Thunderbird also evaluates:
- `/apps/ncc_backend_4mc/api/v1/status`

Runtime behavior:
- checked when Talk wizard opens
- checked when Sharing wizard opens
- checked when add-on settings open and when add-on settings are saved
- valid active seat => each backend value is the initial default until a valid local value exists
- `policy_editable=true` => a stored local value wins and the control remains editable
- `policy_editable=false` => the backend value always wins and the control is locked in the UI
- missing backend / no seat / invalid or overlicensed seat => local add-on settings remain active for the normal local defaults
- backend-only features stay disabled until their backend/seat requirements are met
- if the backend is unreachable, Thunderbird falls back to the locally saved add-on settings for Share/Talk defaults
- if the backend is reachable but the license/seat state is no longer usable, Thunderbird also falls back to the locally saved add-on settings for Share/Talk defaults
- invalid and overlicensed seat states remain visible in the UI so users can contact their administrator
- separate password delivery is only available when the backend endpoint exists and the current user has a usable active assigned seat
- plain separate-password follow-up mails use the captured primary-mail `To`/`Cc`/`Bcc` envelope; auto-send compares all three fields again before sending and opens a manual draft on mismatch or timeout
- Secrets-link delivery creates one one-time Secrets link per recipient and preserves `Bcc` separation
- if Secrets is unavailable or link creation fails, Thunderbird falls back to plain delivery and warns the user
- automatic password follow-up send reuses the same Thunderbird sender identity as the primary mail
- if Thunderbird cannot resolve the sender identity cleanly, or if automatic send fails, the add-on opens a prefilled manual fallback draft instead of attempting an unsafe partial send
- once the primary mail was sent, password-follow-up problems never delete the committed share
- central email signatures are applied only when `policy.email_signature` provides enabled compose policy, rendered HTML, and `user_email`
- for the matching sender identity, enabled compose signature policy also clears Thunderbird identity signatures or Signature Switch signatures in replies and forwards when backend insertion is disabled for that compose type
- Thunderbird applies the central signature only to sender identities whose email address matches `policy.email_signature.user_email`; identity changes are reevaluated immediately before writing, and other identities are left untouched so Thunderbird identity signatures or Signature Switch can continue to work
- the signature settings tab is disabled with the existing backend/seat guidance text while the backend endpoint is unavailable or the current user has no active assigned seat
- if the backend endpoint is available and the seat is active, but the status payload has no `policy.email_signature` domain, only central email signatures stay disabled and the UI asks the user to update/check the backend; Share and Talk policy domains keep working independently
- backend custom templates stay inactive until the corresponding language override is set to `custom`
- the `custom` option is only shown when the backend endpoint exists and stays disabled unless the effective backend policy for that domain is actually `custom` and provides a template
- if `custom` is selected but the backend template is empty or unavailable, Thunderbird falls back to the local UI-default text block
- custom share templates may use `{LINK_INTRO}` and `{LINK_LABEL}`; Thunderbird fills them with share-page wording for normal shares and ZIP-download wording for attachment mode
- current clients prefer the backend's versioned Share template and automatically fall back to the original template field when connected to an older backend; no administrator migration is required
- existing custom templates without these variables remain valid and are rendered unchanged apart from their existing placeholder substitutions
- `policy.talk.event_description_type` may be `html` or `plain_text`; when `html` is active, Thunderbird writes the Talk block into the rich event description editor as HTML and keeps a plain-text representation alongside it for non-HTML consumers
- if effective `policy.talk.talk_set_password` is `true`, the Talk wizard starts with a generated password; users can replace it or generate another one

Central policy can currently control:
- Talk defaults and lock state
- Sharing defaults and lock state
- share HTML/password templates
- central email signature defaults and lock state
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
- `[NCUI][Options]` (settings/options page)
- `[NCUI][OpenUrlFallback]` (browser-open fallback dialog)
- `[ncCalToolbar]` (custom calendar editor toolbar/context bridge)

The bundled `experiments/calendar/**` package remains upstream/as-is. Any console output coming from it is outside the add-on debug-channel rules above.

How to collect useful logs for bug reports:
1. Open the add-on options and enable **Debug logging**.
2. Restart Thunderbird if the problem happens during startup or compose-window creation.
3. Open Thunderbird's Error Console via **Tools -> Developer Tools -> Error Console**.
4. Reproduce the problem.
5. Copy the relevant lines with the prefixes listed above and include the Thunderbird version, add-on version, and affected workflow.
6. Remove app passwords, tokens, private links, customer data, and full mailbox contents before sharing logs.

Screenshots are useful for UI issues, but they should not replace the console lines when the problem involves backend policy, sharing, Talk, signatures, or send/cleanup behavior.

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
2. If a generator endpoint exists on the same origin as the configured Nextcloud base URL, it is used to generate a password server-side.
3. A missing, invalid, or different-origin endpoint is rejected before an authenticated request; the add-on then falls back to a strong local generator.

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

### 4.5.1 Managed Nextcloud URL

Thunderbird exposes extension-specific enterprise policy through `storage.managed`.
NC Connector reads these values:

- `NextcloudUrl` (`string`): full Nextcloud URL, for example `https://cloud.example.com`
- `NextcloudUrlLocked` (`boolean` / `1` / `true`, optional): locks the URL field in the add-on settings

Compatibility aliases are also accepted:

- `nextcloudUrl`
- `nextcloudUrlLocked`
- `baseUrl`
- `baseUrlLocked`

If your enterprise policy stores extension settings inside an `adminSettings` object, NC Connector reads the same keys from there as well.

Behavior:

- if a managed URL exists and the local URL is empty, the add-on pre-fills the managed URL
- if `NextcloudUrlLocked` is true, the add-on always uses the managed URL and disables the URL field
- username and app password are still stored locally per Thunderbird profile
- Thunderbird does not expose platform-specific registry backends directly to extensions; use the `3rdparty.Extensions` policy block shown below, also when deploying via Windows GPO/ADMX

Example `policies.json` snippet:

```json
{
  "policies": {
    "3rdparty": {
      "Extensions": {
        "{4a35421f-0906-439c-bff2-8eef39e2baee}": {
          "NextcloudUrl": "https://cloud.example.com",
          "NextcloudUrlLocked": true
        }
      }
    }
  }
}
```

Merged example with force-install:

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
    "3rdparty": {
      "Extensions": {
        "{4a35421f-0906-439c-bff2-8eef39e2baee}": {
          "NextcloudUrl": "https://cloud.example.com",
          "NextcloudUrlLocked": true
        }
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
- Therefore, if you want a consistent admin-managed rollout, disable and lock these Thunderbird settings via `policies.json`.

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
   - managed `NextcloudUrl` is visible in the add-on settings
   - the URL field is disabled when `NextcloudUrlLocked` is true
   - Thunderbird’s own compose options for missing attachments / large-attachment upload are no longer user-changeable if you locked them

Common issues:
- **Wrong path:** policy file is not read → `about:policies` shows nothing.
- **JSON syntax error:** extension won’t install; `about:policies` shows parse errors.
- **Install URL unreachable:** network/proxy/firewall issue.
- **Managed URL not visible:** ensure the values are below `policies.3rdparty.Extensions.{4a35421f-0906-439c-bff2-8eef39e2baee}` and restart Thunderbird.

---

## 5. Notes about “system-wide configuration”

Enterprise Policies can reliably handle **system-wide installation** and the managed Nextcloud URL.

The add-on’s user-specific functional configuration still lives in:
- `browser.storage.local` (per profile)

If you need more preseeded settings for many users, typical approaches are:
- distribute a pre-configured Thunderbird profile
- use a central onboarding guide and require users to complete Login Flow v2
