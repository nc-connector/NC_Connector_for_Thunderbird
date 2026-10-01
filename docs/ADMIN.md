<a id="administration-guide-nc-connector-for-thunderbird"></a>
<a id="administration-guide--nc-connector-for-thunderbird"></a>
<a id="1-service-scope"></a>

# NC Connector for Thunderbird – Administration

Installation, managed configuration, and troubleshooting for NC Connector's Sharing, Talk, VFS, and backend features.

## Contents

- [Requirements](#requirements)
- [Installation and sign-in](#installation-and-sign-in)
- [Enterprise Rollout](#enterprise-rollout)
- [Managed settings reference](#managed-settings-reference)
- [Backend defaults and signatures](#backend-defaults-and-signatures)
- [Operating notes](#operating-notes)
- [Update, backup, and uninstall](#update-backup-and-uninstall)
- [Troubleshooting](#troubleshooting)
- [Logs and support](#logs-and-support)

<a id="2-requirements"></a>
<a id="21-supported-products"></a>
<a id="23-nextcloud-administration"></a>

## Requirements

| Area | Requirement |
| --- | --- |
| Thunderbird | Version 140 or newer, within the compatibility range listed for the selected add-on release |
| Nextcloud | Version 32 or newer, reachable through HTTPS |
| Sharing | Files Sharing and WebDAV, permission to create public links, write access to the target folder, and enough storage |
| Meetings | Nextcloud Talk and a calendar configured in Thunderbird |
| User search and moderator selection | An exposed [Nextcloud system address book](#system-address-book) |
| Central policies, signatures, separate password delivery, external VFS providers, and Enterprise Rollout | NC Connector Backend and a valid assigned NC Connector Seat for each user |
| One-time password links | The Nextcloud Secrets app in addition |

Without central management, Sharing, Talk, and NC Connector's own VFS provider can use local settings without the backend. Administrator rights do not replace a Seat assignment.

<a id="22-network-access"></a>

### Network access

Use the public Nextcloud URL, such as `https://cloud.example.com` or `https://cloud.example.com/nextcloud`. Do not append `/index.php`, credentials, or query parameters. The workstation must trust the certificate.

The firewall and reverse proxy must allow these paths below that URL:

| Path | Used for |
| --- | --- |
| `/index.php/login/v2` and its subpaths | Browser sign-in and app-password retrieval |
| `/ocs/v2.php/` | Nextcloud account, capabilities, sharing, and Talk requests |
| `/remote.php/dav/` | File access and the system address book |
| `/apps/ncc_backend_4mc/` and `/index.php/apps/ncc_backend_4mc/` | Backend settings and templates; the second path is used as a fallback |

Allow WebDAV methods, including `PROPFIND`, `MKCOL`, `COPY`, `MOVE`, and `DELETE`, as well as `GET`, `PUT`, and `POST`. Preserve `Authorization`, `Destination`, `Depth`, `Overwrite`, `OCS-APIRequest`, `X-NC-WebDAV-Auto-Mkcol`, `OC-Total-Length`, and multipart upload headers. Set request-size limits and timeouts for the files your organization permits.

Browser sign-in must also be able to reach your organization's identity provider if Nextcloud uses single sign-on.

<a id="4-initial-configuration"></a>
<a id="31-individual-installation"></a>
<a id="41-nextcloud-connection"></a>

## Installation and sign-in

1. Install NC Connector from [Thunderbird Add-ons](https://addons.thunderbird.net/en-US/thunderbird/addon/nc4tb/), or download an XPI from [GitHub Releases](https://github.com/nc-connector/NC_Connector_for_Thunderbird/releases) and choose **Install Add-on From File** in Thunderbird's Add-ons Manager.
2. Open **Add-ons Manager → NC Connector for Thunderbird → Preferences / Options**.
3. Under **General**, enter the public Nextcloud URL and choose **Login with Nextcloud**, or enter a username and app password manually. Allow access to the server when Thunderbird asks.
4. Run **Test connection** and save the settings.
5. Create a small share from a message or a Talk link from a calendar event with the intended user account.

Use an app password, not the user's main Nextcloud password. Each user signs in separately; do not distribute credentials with the add-on.

For centrally prepared first sign-in, use [Enterprise Rollout](#enterprise-rollout). The settings remain accessible in Thunderbird.

<a id="6-enterprise-rollout"></a>

## Enterprise Rollout

Managed settings prepare the server address, sign-in method, and source of default values.

**As soon as any supported NC Connector managed key is present, the user needs the backend and a valid assigned Seat.** This includes `false`, empty, and invalid values, and existing deployments that already provide a Nextcloud URL. Force-installing the add-on alone does not activate this requirement.

1. Install and configure NC Connector Backend, then assign Seats to the intended users.
2. Deploy the required managed settings and the add-on.
3. Restart Thunderbird and check `about:policies` for active policies and errors.
4. Check first sign-in with an intended user account before broad deployment.

When backend access cannot be confirmed, new NC Connector operations are unavailable. Initial setup, removing VFS connections, revoking grants, and pending cleanup remain possible. See [backend notices](#backend-notices-and-locked-settings) for corrective steps.

<a id="61-add-on-id-and-policy-locations"></a>

### Policy file and add-on ID

Use Thunderbird's `policies.json`. It applies to the installation and its profiles, not to an individual profile folder.

| Platform | Location |
| --- | --- |
| Windows | `distribution\policies.json` beside `thunderbird.exe`, usually under `C:\Program Files\Mozilla Thunderbird\` |
| macOS | `/Applications/Thunderbird.app/Contents/Resources/distribution/policies.json` |
| Linux | The package's `thunderbird/distribution/policies.json`; system-wide deployment can also use `/etc/thunderbird/policies/policies.json` |

Back up any existing policy file and merge the needed sections instead of replacing unrelated policies. See the [Thunderbird enterprise policy guide](https://thunderbird.github.io/policy-templates/templates/esr140/) for platform deployment.

NC Connector's add-on ID is `{4a35421f-0906-439c-bff2-8eef39e2baee}`.

<a id="62-force-install-example"></a>

### Automatic installation

This example installs NC Connector from Thunderbird Add-ons and allows its updates. For a staged deployment, use the approved XPI location from your software-distribution system instead of the latest-version URL.

```json
{
  "policies": {
    "ExtensionSettings": {
      "{4a35421f-0906-439c-bff2-8eef39e2baee}": {
        "installation_mode": "force_installed",
        "install_url": "https://services.addons.thunderbird.net/thunderbird/downloads/latest/nc4tb/addon-989342-latest.xpi",
        "updates_disabled": false
      }
    }
  }
}
```

<a id="64-managed-nextcloud-url"></a>

## Managed settings reference

Place the following keys under `policies → 3rdparty → Extensions → <add-on ID>`. These are the four supported NC Connector settings for Thunderbird.

| Key | Values | Effect | When absent |
| --- | --- | --- | --- |
| `NextcloudUrl` | HTTPS URL | Fills an empty server address. Replaces a saved address only with the URL lock. | Saved address; empty in a new profile |
| `NextcloudUrlLocked` | `true` / `false` | Locks the address from a valid `NextcloudUrl` when `true`. | URL remains editable |
| `AuthMode` | `LoginFlow` / `Manual` | Selects and locks the sign-in method. | Saved selection; `Manual` in a new profile |
| `DefaultsSource` | `local` / `backend` | Selects and locks the source of defaults unless the backend overrides it. | Backend choice, then user choice, otherwise `local` |

Example with a locked URL, browser sign-in, and backend defaults:

```json
{
  "policies": {
    "3rdparty": {
      "Extensions": {
        "{4a35421f-0906-439c-bff2-8eef39e2baee}": {
          "NextcloudUrl": "https://cloud.example.com",
          "NextcloudUrlLocked": true,
          "AuthMode": "LoginFlow",
          "DefaultsSource": "backend"
        }
      }
    }
  }
}
```

`AuthMode` and `DefaultsSource` accept strings without regard to letter case or surrounding spaces. Use JSON booleans for the URL lock. Existing aliases `nextcloudUrl`, `baseUrl`, `nextcloudUrlLocked`, and `baseUrlLocked`, including settings inside `adminSettings`, remain supported; use the names above for new deployments.

### First sign-in

With managed `AuthMode` and missing credentials, clicking **Insert Nextcloud share** or **Insert Talk link** opens setup with the chosen method locked.

- **LoginFlow:** Browser sign-in starts automatically when the active URL matches the managed URL and Thunderbird has already granted server access. Otherwise, the user clicks **Login with Nextcloud** and grants access if asked. Successful sign-in and connection verification save the credentials and close the setup tab, including after a manual retry.
- **Manual:** The user enters a username and app password, tests the connection, and saves.

After setup, click Share or Talk again in the original message or appointment. Opening Settings normally does not start LoginFlow or close the tab automatically. Complete saved credentials do not trigger a new automatic sign-in.

### Change or remove managed values

Restart Thunderbird after editing the policy. Remove a key to release that setting; do not replace it with an empty value. Removing `AuthMode` restores the saved local method. Removing a URL setting does not undo an address the user has already saved.

To end Enterprise Rollout, remove every supported managed key, including any aliases or values inside `adminSettings`. Keep unrelated Thunderbird policies. Backend rules still apply to users with a valid assigned Seat.

## Backend defaults and signatures

Configure central defaults and templates in **Nextcloud Administration settings → NC Connector Backend**. Policies apply to users with a valid assigned Seat.

Leave **Editable in add-on** enabled when users may change a default. Disable it when a value must be mandatory. Set share expiration to at least one day. Disable the attachment threshold with its switch, not by entering zero; an enabled threshold accepts 1–10240 MB.

<a id="66-default-values-source"></a>

### Default values source

Under **Group Settings → Default Settings → General**, a Nextcloud administrator chooses the source of starting values. This setting is not delegated to group administrators.

| Backend choice | Result in Thunderbird |
| --- | --- |
| **Local** or **Backend**, not editable in the add-on | The backend choice applies, even if managed `DefaultsSource` says something else. |
| **Local** or **Backend**, editable in the add-on | Users can choose under **Advanced → Default values source**. Until they choose, the backend value applies. |
| **No preference**, including an older backend without this setting | Managed `DefaultsSource` applies. If absent, use the user's selection, otherwise **Local**. |

With **Local**, saved local defaults take priority; unset values can come from the backend, then the add-on defaults. With **Backend**, backend values take priority, followed by local and add-on defaults. This applies to Sharing, Talk, attachment automation, text languages, signature switches, and the two VFS switches. Signature templates themselves always come from the backend.

Individually enforced policies always apply. Editable wizard fields can still be changed for the current action.

With **Backend** as the source, the **Sharing**, **Talk Link**, and **Signature** settings tabs are disabled; their saved local values remain. Only the default switches are locked on **VFS**, not connection management. The source selector requires a valid assigned Seat. Reopen settings or the wizard after backend changes.

### Signatures

1. Configure the user's signature template in the backend and assign a valid Seat.
2. Check that the user's email address supplied by the backend matches the Thunderbird sender identity being used.
3. Enable central signatures for new messages and, as required, replies and forwards.
4. Create a message with that sender identity and check the result. Repeat for replies or forwards when used.

For a matching identity, an active central signature replaces the Thunderbird or Signature Switch signature. If replies or forwards are excluded, the central policy does not fall back to another signature for those messages. Other sender identities remain unaffected.

Existing drafts without an NC Connector signature are not automatically given one. Use simple HTML for templates and check the result in the clients your recipients use.

<a id="5-filelink-upload-operation"></a>
<a id="51-user-visible-flow"></a>

## Operating notes

<a id="42-sharing-and-attachment-automation"></a>

### Files and attachment automation

Under **Sharing**, set the base directory, share defaults, and language of the inserted block. Attachment automation can always route attachments through NC Connector or offer it above a size threshold. Automatic attachment shares can link to a ZIP download or the share page; manual shares always link to the share page.

Uploads choose the appropriate transfer method automatically. No server-specific upload-mode tuning is needed in the add-on. If an upload fails, diagnose the connection, permissions, and storage rather than switching transfer methods.

<a id="63-attachment-policy-example"></a>

### Thunderbird's large-attachment prompt

NC Connector's attachment automation controls are unavailable while Thunderbird's native large-attachment notification is enabled. To use NC Connector for this workflow, disable **Offer to share for files larger than** in Thunderbird's attachment settings, or deploy:

```json
{
  "policies": {
    "Preferences": {
      "mail.compose.big_attachments.notify": {
        "Value": false,
        "Status": "locked"
      }
    }
  }
}
```

Merge this into the existing policy, restart Thunderbird, and reopen NC Connector settings. This does not disable Thunderbird's forgotten-attachment reminder. NC Connector's own threshold is configured under **Sharing** or in the backend, not through Thunderbird's `threshold_kb` preference.

<a id="52-cancellation-and-cleanup"></a>
<a id="53-saved-drafts"></a>

### Saved drafts and unused shares

Canceling an upload or discarding an unsaved message removes its newly created share folder when Nextcloud is reachable. Sent messages and saved drafts retain their shares. Temporary cleanup failures are retried, including after a restart with the same Nextcloud account.

Reopen a saved share draft in the Thunderbird profile that created it. The visible share block alone is not enough to transfer it to another profile. If local tracking is lost, create a new message and share the files again.

Do not use **Save as Template** for messages containing NC Connector shares; sending such templates or messages created from them is blocked. Deleting a saved draft does not automatically remove its Nextcloud share. Review unused folders manually, but delete only after confirming that no sent message or saved draft still needs them. Shares may also remain after a crash or when discarding additions to an already saved draft.

<a id="44-optional-backend-policies"></a>

### Separate password delivery

This requires NC Connector Backend and a valid assigned Seat; one-time links also require Nextcloud Secrets. Configure it with the share password options under **Sharing** or in the backend.

- **Send now:** The password message is sent after Thunderbird confirms the main message was sent.
- **Send later:** A prepared password draft opens. Send it manually only after the main message has actually left the Outbox.
- **Save draft:** Keep the prepared password drafts for later manual sending. If they cannot be created, saving or sending the main draft remains blocked until the problem is resolved.
- **Delivery fails:** A prepared message remains available for manual sending. A failure after the main message was sent does not remove its share.
- **Secrets is unavailable or link creation fails:** A warning is shown and delivery falls back to plain text in the separate password message. Each recipient otherwise receives an individual one-time link.

Explain the manual steps for delayed sending and saved drafts when introducing this function. Central configuration is described under [Backend defaults and signatures](#backend-defaults-and-signatures).

### Talk rooms and appointments

Set defaults and the language of inserted meeting text under **Talk Link**. User search, moderator selection, and automatic user/guest assignment need the [system address book](#system-address-book).

Save the appointment after inserting the Talk link. Participant assignment and moderator delegation are processed after saving. Moving and saving an appointment also updates the start time of an enabled lobby.

A room created for an unsaved event is cleaned up if the event is discarded. Deleting the room for an already saved event is a separate, disabled-by-default option under **Talk Link**. Enable it only if deleting the event should also remove the room for all participants. NC Connector leaves the room intact if the user no longer has the necessary authority or another known appointment still references it. A pasted Talk URL alone does not enable automatic room deletion.

<a id="55-mixed-local-nextcloud-and-vfs-sources"></a>
<a id="vfs-sources-and-provider-access"></a>

### My Nextcloud and other storage providers

The Sharing wizard accepts local files, **My Nextcloud**, and connected external providers. My Nextcloud copies files and folders to the new share folder without changing their originals. External files pass through Thunderbird to Nextcloud; they are not transferred directly between the two clouds. Large external files can require substantial Thunderbird memory.

Configure VFS under the **VFS** settings tab:

| Function | Starting value | Access |
| --- | --- | --- |
| NC Connector as a provider | On | Each other add-on needs an explicit grant. The grant gives full read/write access to the configured Nextcloud account; revoke it in the same tab. |
| External VFS providers | Off | Requires a compatible provider add-on, backend access, and a valid assigned Seat. Enable the function, then add the connection. |

The backend can set both switches under **Group Settings → Default Settings → Shares → Thunderbird only – Virtual File System (VFS)**. For centrally managed installations, the Seat requirement also applies to NC Connector's own provider.

There is no second Nextcloud login for VFS. Changing the server or user invalidates existing grants; replacing only the app password for the same account does not. **Disconnect** removes an external connection, not its remote files. Disabling access retains connection records. Save or finish ongoing work before enabling external providers from an already populated sharing queue; follow the displayed restart warning.

<a id="3-install-update-and-roll-back"></a>
<a id="32-managed-update"></a>

## Update, backup, and uninstall

### Update or return to the previous version

1. Save open work, close Thunderbird, and back up the profile before a rollout.
2. Keep the previous approved XPI and policy file. Update through Thunderbird or deploy the approved XPI without uninstalling first.
3. Restart Thunderbird and check the connection and the functions in use on a pilot workstation before expanding deployment.

<a id="33-rollback"></a>

For rollback, stop distributing the new package and deploy the previous compatible XPI. Adjust your update policy so it is not immediately replaced again. Restore a matching profile backup if necessary; this also restores mail and calendar state from that backup. Test with one workstation first. Downgrading does not undo files, shares, or rooms already created in Nextcloud.

<a id="10-backup-and-recovery"></a>

### Back up and restore

Find the active profile through **Help → Troubleshooting Information → Profile Folder**. Close Thunderbird before copying or restoring it. Keep the policy source separately; it is not stored in the profile. See [Thunderbird profile backup and recovery](https://support.mozilla.org/en-US/kb/profiles-where-thunderbird-stores-user-data).

Profile backups contain credentials, preferences, and the records needed for saved-share drafts and pending cleanup. Protect them accordingly and do not distribute a signed-in profile to other users. After restoration, test sign-in; revoke the old app password and sign in again when retiring or replacing a device.

Back up Nextcloud's configuration, database, and storage using your normal server procedure. Restoring a Thunderbird profile does not restore deleted Nextcloud files or rooms.

### Uninstall

Finish or cancel pending uploads, save needed work, and back up the profile. Remove NC Connector through the Add-ons Manager. For a force-installed add-on, change the installation policy first.

Uninstalling normally clears the add-on's local data, including settings and saved-share tracking. Plan to sign in again after reinstalling. This does not delete already stored files, shares, or rooms in Nextcloud; review anything no longer needed separately. Do not uninstall as a routine update or rollback step.

<a id="8-troubleshooting"></a>

## Troubleshooting

### Sign-in or connection fails

1. Open the configured Nextcloud URL in a browser on the workstation. Check the URL, certificate, system time, DNS, and proxy.
2. In NC Connector settings, allow access to that server and run **Test connection**.
3. For HTTP `401`, sign in again. For `403`, check user permissions and gateway restrictions.
4. If only one workstation is affected, compare its certificate, proxy, and endpoint-security settings with a working machine. Do not disable certificate validation.

### Managed settings are missing or invalid

Check `about:policies`, the add-on ID, key spelling, JSON types, and the installed add-on version. Older versions may not support newer keys. Restart Thunderbird after correcting the policy.

| Problem | Action |
| --- | --- |
| Managed URL did not replace a saved URL | Set `NextcloudUrlLocked=true` with a valid managed URL if replacement is intended. |
| Sign-in method is invalid | Set `AuthMode` to `LoginFlow` or `Manual`. Invalid values lock LoginFlow but do not start or save it automatically. |
| Default-values source is invalid | Set `DefaultsSource` to `local` or `backend`. Without an explicit backend override, invalid input locks the source to `local`. |
| Settings cannot be loaded | Correct managed-policy errors first. NC Connector does not silently ignore unreadable policy; connection changes, tests, and login remain blocked in that session. |
| LoginFlow did not start automatically | Check for incomplete credentials, a matching managed URL, and granted server access. Use the login button if permission is still needed. |

<a id="67-managed-installation-cannot-start-an-action"></a>

### Backend notices and locked settings

| Notice or problem | Administrator action |
| --- | --- |
| Backend required | Install or enable `ncc_backend_4mc`, complete setup, and check access to `/apps/ncc_backend_4mc/api/v1/status`. |
| Seat missing, paused, or invalid | Check the affected user's assignment and the license overview in the backend. For paused assignments, adjust capacity or assignments. |
| Access could not be verified | Check the client-to-Nextcloud connection and credentials, then retry. This is not by itself a Seat rejection. |
| License synchronization failed | Check the backend-to-license-server connection and the last successful synchronization. |
| Grace period or activation problem | Follow the action shown in the backend license overview. |
| A value or settings tab is locked | Check managed settings, the default-values source, and **Editable in add-on** in the backend. |
| Unexpected starting values | Check [Default values source](#default-values-source), then reopen settings or the affected wizard. |

Without Enterprise Rollout, users without a valid assigned Seat can still use Sharing and Talk with local settings. Backend-dependent functions are unavailable. Enterprise Rollout requires confirmed backend access; a temporary connection failure may use the most recently confirmed state, but does not grant access for a new user.

<a id="43-talk-and-system-address-book"></a>

### System address book

If user search or moderator selection is disabled, or users are missing:

1. Enable **Administration settings → Groupware → System Address Book** in Nextcloud. Check the user's access and autocompletion rules under **Sharing** as well.
2. Rebuild the address book from the Nextcloud directory. Adapt the HTTP user and command for your container or server:

```bash
sudo -E -u www-data php occ dav:sync-system-addressbook
```

3. Test the export with the affected user's credentials. Replace `<user-id>` with the Nextcloud user ID, which may differ from the email address used for sign-in:

```text
https://cloud.example.com/remote.php/dav/addressbooks/users/<user-id>/z-server-generated--system/?export
```

4. Reopen NC Connector settings or the Talk wizard and repeat the search.

Expect a vCard address book, not an HTML login or error page. NC Connector also accepts a valid, non-empty export returned with HTTP `404`; an empty or damaged response is not accepted. For `401`, check credentials; for `403`, check access rights. A failed refresh stops participant classification rather than treating internal users as guests.

If Nextcloud reports the address book as enabled but the export remains unavailable, check the saved setting:

```bash
sudo -E -u www-data php occ config:app:get dav system_addressbook_exposed
```

If exposure is intended and the value is not `yes`, correct it and rebuild:

```bash
sudo -E -u www-data php occ config:app:set dav system_addressbook_exposed --value="yes"
sudo -E -u www-data php occ dav:sync-system-addressbook
```

See the [Nextcloud system address book guide](https://docs.nextcloud.com/server/32/admin_manual/groupware/contacts.html#system-address-book).

<a id="81-upload-is-rejected-before-it-starts"></a>
<a id="82-progress-remains-at-zero"></a>
<a id="83-upload-stalls-or-repeatedly-fails"></a>
<a id="54-retries-and-server-throttling"></a>

### Upload does not start or repeatedly fails

1. Check the phase shown in the wizard. Large folders take time to scan before uploaded bytes increase.
2. Confirm Nextcloud 32 or newer, readable source files, destination write access, and public-sharing permission.
3. If connection testing reports an unreadable server response, check whether a proxy returned HTML instead of Nextcloud data, especially for `/ocs/v2.php/cloud/capabilities`.
4. Match the failure time with the client and server logs. Check DAV methods and headers against [Network access](#network-access); a blocked `MOVE` or `DELETE` can break upload completion or cleanup.
5. If only large files fail, check proxy size limits, timeouts, buffering, and server storage performance.

HTTP `423` indicates a lock, `429` rate limiting, and `502`–`504` an upstream or gateway failure. Temporary errors are retried automatically within limits; repeated failures need server-side diagnosis.

<a id="84-insufficient-storage-507"></a>

### Insufficient storage (`507`)

Check the user's quota, applicable group-folder quota, primary storage, and temporary space used by the web server or proxy. Free or extend storage before retrying. The wizard also blocks uploads when the selected files exceed the available quota it can determine.

<a id="85-folder-name-collision"></a>

### Share folder already exists

Choose a different share name in the manual wizard. Attachment automation can choose a numbered name. Do not delete an existing folder just because its name matches; an earlier message may still link to it.

<a id="86-cleanup-did-not-complete"></a>

### An unused share remains

Confirm that no sent message or saved draft needs the share. Check the connection, account credentials, and whether the proxy permits `DELETE`; pending cleanup retries when the same account is available. Deleting a saved draft can leave its share behind. Remove a confirmed orphan in Nextcloud, not by clearing the Thunderbird profile's tracking data.

<a id="87-a-saved-share-draft-cannot-be-sent"></a>

### A saved share draft cannot be sent

Use the Thunderbird profile that created it, not another profile or a template. If separate password delivery is enabled, save again and check that the prepared password drafts open. If the original tracking data is missing or the error persists, create a new message and share again; copying only the visible block does not repair it.

### A signature is missing or duplicated

Check the Seat assignment, template, backend email address, selected Thunderbird sender identity, and signature switches. Test a new message with that identity. For a duplicate, check when the other signature tool inserts its content; provide a reproducible example rather than disabling signatures for unrelated accounts. See [Signatures](#signatures).

<a id="88-public-talk-links-work-only-with-indexphp"></a>
<a id="11-nextcloud-pretty-urls"></a>
<a id="111-quick-check"></a>

### Talk link returns 404 in the browser

Compare `https://cloud.example.com/login` with `https://cloud.example.com/index.php/login`. If only the latter works, correct the web-server rewrite using the official Nextcloud configuration. For subpath installations, retain `/nextcloud` in both addresses. Do not add `/index.php` to the add-on's server address as a workaround.

Back up server configuration before changing it, validate it before reloading, and then test both the login page and a newly created Talk link from a client.

<a id="112-nginx"></a>

For **Nginx**, use the [complete Nextcloud configuration](https://docs.nextcloud.com/server/32/admin_manual/installation/nginx.html), including the correct web-root or subpath variant. Do not replace it with isolated rewrite snippets.

<a id="113-apache"></a>

For **Apache**, check rewrite modules, `AllowOverride`, and the rewrite base, then regenerate `.htaccess` after changes. Follow the [Nextcloud Pretty URL instructions](https://docs.nextcloud.com/server/32/admin_manual/installation/source_installation.html#pretty-urls).

<a id="65-rollout-verification"></a>
<a id="7-operational-checks"></a>

### Check operation after a change

After an add-on, server, proxy, or policy change, test the connection and the affected feature with an intended user account. For a rollout, also confirm active policies in `about:policies`, first sign-in, a small share, a Talk link, and a signature if used. Exercise a large upload or a folder only when those workflows are in use. Use a test message and remove any test shares afterward.

<a id="45-debug-logging"></a>
<a id="9-logging-and-support-data"></a>

## Logs and support

1. Enable **Debug logging** on the add-on's **Debug** tab.
2. Open Thunderbird's **Error Console** and reproduce the issue once.
3. Record the time, Thunderbird and add-on versions, Nextcloud and relevant app versions, action, error message, and matching log lines. Include the HTTP status from the server or proxy where relevant.
4. Review the excerpt for credentials, private share or Secret links, filenames, recipients, and customer data before forwarding it.
5. Turn debug logging off again after diagnosis.

`[NCBG]` covers background work, uploads, and calendar processing. `[NCUI][Sharing]`, `[NCUI][Talk]`, and `[NCUI][Options]` identify the corresponding interfaces; `[ncCalToolbar]` concerns the calendar button and editor.

Use the [support form](https://nc-connector.de/support/) with the relevant excerpt rather than sending a complete Thunderbird profile. Developer implementation and test details are documented separately in [DEVELOPMENT.md](DEVELOPMENT.md).
