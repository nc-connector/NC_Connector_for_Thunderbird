# Administration Guide — NC Connector for Thunderbird

This guide is for administrators and operations teams that deploy and run NC Connector for Thunderbird. Source layout, protocol implementation, and developer tests are documented in `docs/DEVELOPMENT.md`.

## Contents

- [1. Service scope](#1-service-scope)
- [2. Requirements](#2-requirements)
- [3. Install, update, and roll back](#3-install-update-and-roll-back)
- [4. Initial configuration](#4-initial-configuration)
- [5. FileLink upload operation](#5-filelink-upload-operation)
- [6. Enterprise rollout](#6-enterprise-rollout)
- [7. Operational checks](#7-operational-checks)
- [8. Troubleshooting](#8-troubleshooting)
- [9. Logging and support data](#9-logging-and-support-data)
- [10. Backup and recovery](#10-backup-and-recovery)
- [11. Nextcloud Pretty URLs](#11-nextcloud-pretty-urls)

## 1. Service scope

NC Connector integrates the following Nextcloud functions into Thunderbird:

- Files Sharing and WebDAV uploads from new messages, replies, and forwards
- Nextcloud Talk rooms from calendar events
- optional central policies, templates, and email signatures from NC Connector Backend
- optional one-time Secret links for separate password delivery

Sharing and Talk work without the optional backend. Backend-dependent controls remain unavailable until the backend endpoint is reachable and the current user has a usable assigned seat.

## 2. Requirements

### 2.1 Supported products

- Thunderbird ESR 140 through ESR 153
- Nextcloud 32 or newer
- Nextcloud Files Sharing and WebDAV
- Nextcloud Talk for calendar meeting functions
- Nextcloud Secrets plus NC Connector Backend for Secret-link password delivery

NC Connector checks the Nextcloud capabilities before starting a FileLink upload. A server older than Nextcloud 32, an unreadable capability response, or a response without a valid server version stops the operation before the share upload folder is created.

### 2.2 Network access

Thunderbird clients need HTTPS access to the configured Nextcloud origin. Firewalls, proxies, and application gateways must allow:

- OCS requests below `/ocs/v2.php/`
- Login Flow v2 below `/index.php/login/v2/`
- WebDAV below `/remote.php/dav/`
- the optional backend below `/apps/ncc_backend_4mc/`

FileLink uses `PROPFIND`, `MKCOL`, `PUT`, `POST`, `MOVE`, and `DELETE`. A proxy that permits only `GET` and `POST` breaks upload, collision handling, or cleanup.

Keep these request properties intact:

- `Authorization`
- `Destination`
- `Overwrite`
- `OCS-APIRequest`
- `X-NC-WebDAV-AutoMkcol`
- `OC-Total-Length`
- multipart part headers used by Nextcloud DAV bulk upload

Set proxy upload limits and timeouts for the largest file size permitted by your organization. Review request buffering on reverse proxies when large uploads consume excessive temporary disk space.

### 2.3 Nextcloud administration

The configured user needs permission to:

- create folders and upload files below the selected FileLink base directory
- create and remove public shares
- create Talk rooms when Talk is used

Public-link creation can also be restricted by Nextcloud sharing policy. Test with the same account and group membership as an affected user.

## 3. Install, update, and roll back

### 3.1 Individual installation

1. Download the signed XPI from [ATN](https://addons.thunderbird.net/de/thunderbird/addon/nc4tb/) or [GitHub Releases](https://github.com/nc-connector/NC_Connector_for_Thunderbird/releases).
2. Open Thunderbird's Add-ons Manager.
3. Select **Install Add-on From File** and choose the XPI.
4. Restart Thunderbird when requested.
5. Open the NC Connector options and complete the connection test.

Expected result: the options page reports a successful Nextcloud connection and the Share action is available in a compose window.

### 3.2 Managed update

For ATN-managed installations, keep add-on updates enabled in Thunderbird policy. For staged rollouts:

1. Test the new XPI with the supported Thunderbird and Nextcloud versions.
2. Test one small file, one large file, a folder tree, cancellation, and an unsent-draft cleanup.
3. Deploy to a pilot group.
4. Review debug logs and Nextcloud WebDAV logs.
5. Expand the rollout.

### 3.3 Rollback

Keep the previously approved signed XPI before deployment.

1. Stop the rollout of the newer package.
2. Install or publish the previous XPI through the same deployment channel.
3. Restart Thunderbird.
4. Run the checks in [Operational checks](#7-operational-checks).

Rollback does not remove Nextcloud shares that users already sent. Unsent shares still follow the normal draft and wizard cleanup rules while the active add-on version is running.

## 4. Initial configuration

### 4.1 Nextcloud connection

In Thunderbird, open **Add-ons Manager → NC Connector for Thunderbird → Preferences / Options**.

1. Enter the public Nextcloud base URL, including an installation path such as `/nextcloud` when present.
2. Select **Login with Nextcloud** or enter a Nextcloud app password.
3. Run **Test connection**.
4. Save the options.

Use an app password instead of the user's main password. Revoke the app password in Nextcloud when a device is lost or retired.

Do not add `/index.php` to the configured base URL to work around broken public routing. Correct the Pretty URL configuration as described in [Nextcloud Pretty URLs](#11-nextcloud-pretty-urls).

### 4.2 Sharing and attachment automation

Administrators should define:

- the FileLink base directory
- default share permissions and expiry
- whether a share password is preselected
- whether password delivery uses the main message or a separate follow-up
- whether attachment automation always routes attachments through NC Connector or offers it above a size threshold
- whether attachment shares insert a ZIP download or the Nextcloud share page

Manual shares always insert the share page. Attachment automation can insert either supported target. The selected target changes the link and wording, not the recipient permissions or cleanup rules.

When NC Connector owns the attachment workflow, disable Thunderbird's competing large-attachment prompt through enterprise policy. See [Attachment policy example](#63-attachment-policy-example).

Do not use **Save as Template** for a message that contains an NC Connector share. Thunderbird templates can create independent messages without a reliable share lifecycle; NC Connector therefore blocks sending such templates and messages created from them.

### 4.3 Talk and system address book

Talk user search, moderator selection, and participant controls require the Nextcloud system address book.

On Nextcloud 32 or newer:

1. Open **Administration settings → Groupware**.
2. Enable **System Address Book**.
3. Open **Administration settings → Sharing**.
4. Check that username autocompletion and system-address-book access are permitted.
5. Reopen the NC Connector settings or Talk wizard.

If the administration UI reports the address book as enabled but clients still cannot use it:

```bash
sudo -E -u www-data php occ config:app:delete dav system_addressbook_exposed
sudo -E -u www-data php occ config:app:set dav system_addressbook_exposed --value="yes"
sudo -E -u www-data php occ dav:sync-system-addressbook
```

Then open the following URL in an authenticated browser session:

```text
https://cloud.example.com/remote.php/dav/addressbooks/users/<user>/z-server-generated--system/?export
```

Expected result: the request returns the system address book instead of `404` or `403`.

### 4.4 Optional backend policies

When `ncc_backend_4mc` is installed, the add-on reads central policies when the Talk wizard, Sharing wizard, or options page opens.

Operational rules:

- an active assigned seat activates the corresponding policy domains
- editable values allow a local user choice
- locked values remain controlled by the backend
- an unavailable backend leaves normal local Share and Talk defaults active
- an unavailable or unusable seat disables backend-only functions
- each policy domain is evaluated separately; a missing signature policy does not disable Share or Talk policies

Separate password delivery is available only with a reachable backend and usable assigned seat. After **Send now**, the password follow-up is sent only after Thunderbird confirms that the primary message was sent. After **Send later**, NC Connector opens a clearly marked password draft instead of sending it automatically; the user sends that draft manually only after the main message has actually left the Outbox. If automatic follow-up delivery fails, NC Connector keeps or opens a prepared draft for manual sending. A follow-up failure after primary-message delivery does not delete the committed share.

### 4.5 Debug logging

Keep debug logging disabled during normal operation unless your support policy requires it. Enable it temporarily while reproducing a fault, then disable it after collecting the required lines.

## 5. FileLink upload operation

### 5.1 User-visible flow

After the normal Nextcloud connection and FileLink options are configured, high-speed method selection requires no additional setting. For every upload, NC Connector:

1. reads the Nextcloud 32 capabilities
2. scans the selected files and folders
3. prepares the remote folder structure
4. uploads the files through the applicable Nextcloud DAV upload methods
5. creates the public share
6. inserts the share block into the message

The progress view reports folder preparation, completed files, transferred bytes, percentage, and current transfer rate. Status and debug output are aggregated, so a large folder should not produce one console entry for every low-level progress event.

The client automatically chooses among direct upload, chunked upload v2, and DAV bulk upload. DAV bulk is used only when Nextcloud advertises the required capability and the selected file set benefits from fewer requests. There is no administrator or user toggle for the upload method.

### 5.2 Cancellation and cleanup

Closing the Sharing wizard or canceling an active upload stops pending transfer work. NC Connector then removes the reserved FileLink share folder when it owns that folder.

After a share is inserted into a compose window:

- every share inserted into the same draft is tracked
- closing an unsaved draft without a confirmed send removes all of its tracked share folders
- closing a successfully saved draft retains its shares so the draft can be reopened
- a successful **Send now** or **Send later** keeps all shares from that message
- a close event while Thunderbird is still finalizing send uses a short grace period before cleanup
- password-follow-up errors after successful primary send do not remove the share

Chunked transfer also uses a temporary collection below `/remote.php/dav/uploads/<user-id>/`. NC Connector deletes this collection after a failed or canceled transfer when the server remains reachable. Nextcloud removes a chunk collection after 24 hours without activity. This server-side expiry does not apply to completed FileLink share folders.

Pending cleanup survives a Thunderbird or device restart and resumes when the same Nextcloud account is configured and reachable. NC Connector never applies an old cleanup record to a different Nextcloud URL or user. After the bounded retries are exhausted, administrators can identify and remove stale folders below the configured FileLink base directory after confirming that no sent or saved message still depends on the share.

If Thunderbird terminates while the final send result is still uncertain, NC Connector keeps the share. Retaining a possibly unused folder is safer than deleting a link from a message that may already have been sent.

### 5.3 Saved drafts

An NC Connector share draft must be reopened and sent from the same Thunderbird profile that created it. The profile stores the local ownership record required to distinguish a valid saved draft from copied or incomplete content. If that record or the draft marker is missing or inconsistent, sending is blocked; create a new message and share the files again.

When a user adds another share to an already saved draft and then discards those unsaved changes, NC Connector conservatively retains both the original and the new share. This prevents deletion of the link still stored in the earlier draft version, but the newly created folder may require manual orphan cleanup.

For a share with separate password delivery, saving the main draft opens prepared password drafts for manual delivery. NC Connector does not persist the password payload in its cleanup record. If Thunderbird cannot create all required password drafts, the main draft remains blocked until saving is retried successfully or the share is recreated.

Deleting a saved message directly from the Drafts folder is not exposed to NC Connector as a compose-close event. Its remote share can therefore remain in Nextcloud. Include the configured FileLink base directory in periodic orphan review and remove a folder only after confirming that no saved or sent message uses it.

### 5.4 Retries and server throttling

Short-lived lock, rate-limit, gateway, and service-unavailable responses are retried for requests that can be repeated safely. A valid `Retry-After` value is honored up to 30 seconds.

DAV and OCS control requests stop after 60 seconds per attempt, active upload requests after five minutes, and cleanup requests after 10 seconds per attempt. These limits prevent a stalled proxy or server connection from leaving one request open without a bound.

NC Connector does not silently change to another upload mode after a protocol failure. This keeps server and proxy faults visible instead of masking them through a second transfer path.

## 6. Enterprise rollout

### 6.1 Add-on ID and policy locations

Add-on ID:

```text
{4a35421f-0906-439c-bff2-8eef39e2baee}
```

Common `policies.json` locations:

- Windows: `C:\Program Files\Mozilla Thunderbird\distribution\policies.json`
- macOS: `/Applications/Thunderbird.app/Contents/Resources/distribution/policies.json`
- Linux: `/usr/lib/thunderbird/distribution/policies.json` or the distribution path used by the package

Use `about:policies` in Thunderbird to check discovery and parse results.

### 6.2 Force-install example

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

### 6.3 Attachment policy example

When NC Connector should own the attachment workflow, lock Thunderbird's native attachment prompts:

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

Merge this block into the existing policy file.

### 6.4 Managed Nextcloud URL

Thunderbird's `3rdparty.Extensions` policy can prefill and lock the public Nextcloud URL:

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

Credentials remain in each Thunderbird profile. The managed policy does not distribute usernames or app passwords.

No `3rdparty.Extensions` entry is required for an unmanaged installation.
Thunderbird's documented “Managed storage manifest not found” result is treated
as the normal absence of an enterprise policy; the add-on then loads the local
profile settings.

If Thunderbird cannot read managed extension policy, NC Connector blocks
connection changes and connection tests for that run instead of silently using
a locally stored URL. Existing local credentials remain stored and visible but
cannot be used or overwritten from that failed settings session. Check
`about:policies`, correct the policy error, and restart Thunderbird.

### 6.5 Rollout verification

1. Open `about:policies`.
2. Check that no policy parse error is shown.
3. Restart Thunderbird.
4. Check that the add-on is installed and enabled.
5. Check that the managed URL is visible and locked when configured.
6. Open a compose window and test a small FileLink share.
7. Repeat with a file larger than 20 MiB and a folder containing many small files.
8. Close an unsent test draft and confirm that its share folder is removed.

## 7. Operational checks

Run these checks after installation, update, rollback, proxy change, or Nextcloud upgrade:

| Check | Expected result |
|---|---|
| Connection test | Credentials, origin access, and Nextcloud 32 capabilities are accepted |
| Small file share | Upload finishes, the share block is inserted, and its link opens the public share page |
| File larger than 20 MiB | Chunked upload finishes and the final file size matches |
| Folder with many small files | Progress advances without repeated `0%` status or console flooding |
| Manual cancel | Upload stops and the temporary share folder is removed |
| Unsent draft close | Inserted share is removed |
| Send later | Primary message enters Outbox and the share remains |
| Server quota exhausted | User sees the localized insufficient-storage message |
| Talk room | Public `/call/<token>` link opens from an external client |

For load-sensitive environments, also review:

- Nextcloud web-server request duration and status codes
- PHP worker saturation
- reverse-proxy body buffering and temporary-disk usage
- user quota and server free space
- HTTP `423`, `429`, `502`, `503`, `504`, and `507` rates

## 8. Troubleshooting

### 8.1 Upload is rejected before it starts

Symptoms:

- the minimum-version message is shown
- no new share folder appears

Checks:

1. Confirm that the server is Nextcloud 32 or newer.
2. Open the capabilities endpoint with an authenticated test client.
3. Check proxy rules for `/ocs/v2.php/cloud/capabilities`.
4. Check whether a login portal, WAF, or proxy returns HTML instead of OCS JSON.

### 8.2 Progress remains at zero

The first phases can remain at zero bytes while the client scans a large local folder, hashes files selected for DAV bulk upload, checks capabilities, or prepares remote folders.

Checks:

1. Read the phase shown below the progress bar.
2. Check the latest `[NCBG]` and `[NCUI][Sharing]` debug entries.
3. Check Nextcloud access logs for capabilities, `PROPFIND`, `MKCOL`, or upload requests.
4. Check client CPU and disk activity when many small files are being scanned or hashed.
5. Check reverse-proxy buffering and request-size limits.

The console should show periodic summaries, not a line for every byte-progress event. A renewed log flood is a defect worth reporting with the add-on version and a redacted log excerpt.

### 8.3 Upload stalls or repeatedly fails

Checks:

1. Identify the HTTP status in the client and server logs.
2. Confirm that the proxy permits DAV `MOVE` and `DELETE`.
3. Confirm that the proxy forwards `Destination`, `Overwrite`, and `X-NC-WebDAV-AutoMkcol`.
4. Compare the proxy timeout with the duration of the failing request.
5. Check Nextcloud background load, PHP workers, database locks, and storage latency.

`423` usually indicates a temporary lock. `429` indicates rate limiting. `502`, `503`, and `504` point to the proxy or an unavailable upstream service.

### 8.4 Insufficient storage (`507`)

NC Connector shows a specific localized insufficient-storage message for HTTP `507`, including a failed item inside a DAV bulk response.

Check:

- the user's Nextcloud quota
- group-folder quota where applicable
- free space and inode availability on the primary storage
- object-storage capacity and credentials
- temporary storage used by the web server, PHP, and reverse proxy

Free or extend storage, then start the upload again. Do not instruct users to keep retrying while the quota condition remains.

### 8.5 Folder name collision

Manual sharing stops when the target share folder already exists. Choose another share name. Attachment automation may use the next numbered name.

A collision check and folder reservation happen on the server. Avoid deleting an existing folder solely because its name matches; it may belong to an earlier sent message.

### 8.6 Cleanup did not complete

1. Confirm that the affected message was not sent.
2. Check the Nextcloud activity and WebDAV logs for `DELETE`.
3. Check whether the proxy allows `DELETE`.
4. Check whether the user's app password was revoked during the upload.
5. Wait for the bounded cleanup retries after 2, 5, 10, 30, and 60 seconds.
6. Remove the stale share and folder in Nextcloud after verifying ownership and message state.

### 8.7 A saved share draft cannot be sent

1. Confirm that the draft was opened in the Thunderbird profile that created the share.
2. Save it again and check whether required manual password drafts open.
3. Do not use a Thunderbird template containing an NC Connector share.
4. If NC Connector still blocks sending, create a new message and create the share again. Do not copy only the visible share block into another message.

### 8.8 Public Talk links work only with `/index.php/`

This is a Pretty URL fault. Follow [Nextcloud Pretty URLs](#11-nextcloud-pretty-urls). Do not change the NC Connector base URL to include `/index.php`.

## 9. Logging and support data

Enable **Debug logging** in the add-on options and reproduce the issue once.

Relevant prefixes:

- `[NCBG]` — background, upload, cleanup, and calendar processing
- `[NCUI][Sharing]` — Sharing wizard
- `[NCUI][Talk]` — Talk wizard
- `[NCUI][Options]` — settings
- `[ncCalToolbar]` — calendar editor bridge

Collect:

- Thunderbird version
- NC Connector version
- Nextcloud version
- operation and approximate time
- first relevant error and the preceding phase summary
- matching HTTP status from proxy or Nextcloud logs

Remove app passwords, authorization headers, share tokens, private links, file names, recipients, and customer data before forwarding logs.

## 10. Backup and recovery

NC Connector does not maintain an independent server-side database. Nextcloud remains the system that stores uploaded files, shares, Talk rooms, policies, and templates.

For client recovery:

- retain the enterprise policy source and the previously approved XPI
- follow your normal Thunderbird profile backup policy
- treat profile backups as sensitive because they may contain the Nextcloud app password
- after restoring a profile to another device, consider revoking the old app password and running Login with Nextcloud again

For Nextcloud recovery, use the normal Nextcloud backup and restore procedure for configuration, database, and storage. After a restore, run the operational checks in this guide.

## 11. Nextcloud Pretty URLs

NC Connector builds public Talk links as:

```text
https://cloud.example.com/call/<TOKEN>
```

For a subpath installation:

```text
https://cloud.example.com/nextcloud/call/<TOKEN>
```

### 11.1 Quick check

At the web root, open:

```text
https://cloud.example.com/index.php/login
https://cloud.example.com/login
```

Below `/nextcloud`, open:

```text
https://cloud.example.com/nextcloud/index.php/login
https://cloud.example.com/nextcloud/login
```

Both forms must reach Nextcloud or redirect to its login page. If only the `index.php` form works, fix the web-server rewrite.

### 11.2 Nginx

Use Nextcloud's full Nginx example as the baseline. The relevant web-root fallback is:

```nginx
location / {
    try_files $uri $uri/ /index.php$request_uri;
}
```

The PHP/FastCGI location also needs:

```nginx
fastcgi_param front_controller_active true;
```

For a `/nextcloud` installation, the fallback must include the subpath:

```nginx
location /nextcloud {
    try_files $uri $uri/ /nextcloud/index.php$request_uri;
}
```

Validate and reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### 11.3 Apache

Apache must load `mod_rewrite` and `mod_env`, and the Nextcloud `<Directory>` block must permit `.htaccess` processing with `AllowOverride All`.

```bash
sudo a2enmod rewrite env
sudo systemctl reload apache2
```

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

Regenerate `.htaccess`:

```bash
cd /var/www/nextcloud
sudo -E -u www-data php occ maintenance:update:htaccess
sudo systemctl reload apache2
```

If rewriting still fails after checking the modules, `AllowOverride`, rewrite base, and regenerated `.htaccess`, add:

```php
'htaccess.IgnoreFrontController' => true,
```

Run `maintenance:update:htaccess` again and reload Apache.

Official references:

- [Nextcloud Nginx configuration](https://docs.nextcloud.com/server/stable/admin_manual/installation/nginx.html)
- [Nextcloud Apache and Pretty URLs](https://docs.nextcloud.com/server/stable/admin_manual/installation/source_installation.html#pretty-urls)
- [Nextcloud `maintenance:update:htaccess`](https://docs.nextcloud.com/server/stable/admin_manual/occ_system.html#maintenance-commands)
