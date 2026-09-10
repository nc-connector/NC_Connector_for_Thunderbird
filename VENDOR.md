# Third-Party Dependencies

## ical.js

- Package: `ical.js`
- Version: `2.2.1`
- Source: https://registry.npmjs.org/ical.js/-/ical.js-2.2.1.tgz
- Upstream repository: https://github.com/kewisch/ical.js
- Included file: `vendor/ical.js` (UMD/CJS distribution from `dist/ical.es5.cjs`)
- License: MPL-2.0
- Usage in this add-on:
  - iCalendar parsing/writing rules in `modules/icalContract.js`
  - Runtime consumers:
    - `modules/bgCalendar.js`
    - `modules/bgCalendarLifecycle.js`
    - `modules/talkAddressbook.js`

## DOMPurify

- Package: `dompurify`
- Version: `3.4.13`
- Source: https://registry.npmjs.org/dompurify/-/dompurify-3.4.13.tgz
- Source integrity (SHA-512): `sha512-2vmYIoqjze2d+kakP8S/nS5shfsl587kzwEjcGlTdiksUVgFHnFCsLYDVj/JNqJVOQZGSYBTmuycv0PodwmnMQ==`
- Upstream repository: https://github.com/cure53/DOMPurify
- Included file: `vendor/purify.js` (unchanged UMD browser distribution from `dist/purify.js`)
- SHA-256: `DD9516732E75EF096EBC8347F0D7F08C7B969C409ED050C85560F214A0F704F9`
- License: Apache-2.0 OR MPL-2.0
- Usage in this add-on:
  - Client-side sanitization of backend-provided Talk invitation HTML
  - Client-side sanitization of backend-provided Share/Password HTML templates
  - Client-side sanitization of backend-provided email-signature HTML templates
  - Runtime consumers:
    - `modules/htmlSanitizer.js`
    - `modules/bgRouter.js`
    - `modules/ncSharing.js`
    - `modules/bgSignature.js`
    - `ui/talkDialog.js`
- Module-format review:
  - The unchanged UMD browser distribution is loaded as a local ordered script
    before `modules/htmlSanitizer.js` in the background, Talk dialog, and
    Sharing wizard.
  - It exposes only the local `DOMPurify` runtime; no remote module or script is
    loaded.

## SparkMD5

- Package: `spark-md5`
- Version: `3.0.2`
- Source: https://registry.npmjs.org/spark-md5/-/spark-md5-3.0.2.tgz
- Upstream repository: https://github.com/satazor/js-spark-md5
- Included file: `vendor/spark-md5.min.js` (unchanged UMD browser distribution)
- SHA-256: `D80E84C820CC5587A0BA3C8A20652099EA3FA7FC43944E812E56D449C1D9F1C9`
- License: WTFPL OR MIT
- Usage in this add-on:
  - MD5 values required by Nextcloud DAV bulk-upload parts
  - Runtime consumer:
    - `modules/fileLinkBulkUpload.js`
- Module-format review:
  - The add-on background still uses Manifest V2 ordered scripts.
  - The UMD build exposes `SparkMD5` in that existing script context.

## Thunderbird VFS Toolkit

- Component: `vfs-toolkit`
- API version: `1.3`
- Upstream repository: https://github.com/thunderbird/webext-support
- Upstream base commit: [`3476faa0870bb6dbe63c7c72fc3dab2b67731f4e`](https://github.com/thunderbird/webext-support/commit/3476faa0870bb6dbe63c7c72fc3dab2b67731f4e)
- Source subtree: `modules/vfs-toolkit`
- License: MPL-2.0; the upstream repository license is stored in `vendor/vfs-toolkit/LICENSE`.
- Included runtime files:
  - client API and built-in OPFS provider: `vendor/vfs-toolkit/vfs-client/*.mjs`
  - picker: `vendor/vfs-toolkit/vfs-client/picker.html`, `picker.mjs`, `picker.css`, and `icon-configure.svg`
  - picker translations: `vendor/vfs-toolkit/vfs-client/locales/*.json`
  - provider API: `vendor/vfs-toolkit/vfs-provider/vfs-provider.mjs`
- Module format:
  - The client and provider APIs are native ES modules (`.mjs`).
  - Picker assets and translations are local package resources; no remote script or module is loaded.
- Applied upstream contribution series:
  - [PR #96](https://github.com/thunderbird/webext-support/pull/96)
    - `e1a6a69dfaf7cee34999987dff1b63ba710d9409` — co-located VFS clients and providers use the same authenticated command handler as external ports.
    - `95f9a744fef07f2b8fb89b39d23b3a49672ef3ca` — connection setup waits until the client-side connection cache is usable.
    - `7bfe56256d11d430c66a9bf4a4a321b4d70f2b7f` — grants are bound to the verified runtime consumer and storage pair.
    - `a82f2b767f4183f582ed33e81cd35a1c45639430` — list, read, and picker requests support request-scoped cancellation.
  - [PR #97](https://github.com/thunderbird/webext-support/pull/97)
    - `979429022cc074122c655d7210a9d746f7e33f05` — Dutch, Polish, Simplified Chinese, and Traditional Chinese picker translations and regional locale matching.
  - [PR #98](https://github.com/thunderbird/webext-support/pull/98)
    - `f50d445dc52c4b4a0b79f7b7a5e7984144d1958c` — picker clients can hide toolbar management actions while retaining search and filters.
    - `baf1c7673ec22208a563afc02b9c7c7bb97c8d3d` — picker clients can hide file and folder context menus.
- The vendored runtime is the combined result of the pinned base plus those upstream PR commits, normalized to LF. It contains no NC Connector-specific functional or CSS changes.
- The overlapping `vfs-client.mjs` changes retain request cancellation together with the two picker visibility options.

### SHA-256 integrity

`Combined upstream PR` is calculated after applying the listed PR commits to the pinned base and normalizing files to LF. Both columns must match.

| Local file | Combined upstream PR SHA-256 | Vendored SHA-256 |
| --- | --- | --- |
| `LICENSE` | `1F256ECAD192880510E84AD60474EAB7589218784B9A50BC7CEEE34C2B91F1D5` | `1F256ECAD192880510E84AD60474EAB7589218784B9A50BC7CEEE34C2B91F1D5` |
| `vfs-client/icon-configure.svg` | `342E9E9627EA98D308874F3C3D72C319FAD7919E2C22F1EEC6150705701CACDD` | `342E9E9627EA98D308874F3C3D72C319FAD7919E2C22F1EEC6150705701CACDD` |
| `vfs-client/locales/cs.json` | `C85CC8F343E2970135AC823C567AD9D6A6A6AA6787995C2F79E56F499FB708C6` | `C85CC8F343E2970135AC823C567AD9D6A6A6AA6787995C2F79E56F499FB708C6` |
| `vfs-client/locales/de.json` | `3F2AD3DA930E3639EF1B35F3D343BE9C75B6B92C65AD6B1071DA50F2D39EAAF8` | `3F2AD3DA930E3639EF1B35F3D343BE9C75B6B92C65AD6B1071DA50F2D39EAAF8` |
| `vfs-client/locales/en.json` | `2FD211CE65F498415923F8CC338C9C8B381763CB25082A40BFD69E6CB3DF911B` | `2FD211CE65F498415923F8CC338C9C8B381763CB25082A40BFD69E6CB3DF911B` |
| `vfs-client/locales/es.json` | `CE2CA52E4099828600710E9F6EE66AB16F1AF3AFFDFB115FA846A5EB354D2D0B` | `CE2CA52E4099828600710E9F6EE66AB16F1AF3AFFDFB115FA846A5EB354D2D0B` |
| `vfs-client/locales/fr.json` | `83B7D7F94713FD3630F03E72BBDC09C260A374C74320C685CF4C16F5FCD39CBF` | `83B7D7F94713FD3630F03E72BBDC09C260A374C74320C685CF4C16F5FCD39CBF` |
| `vfs-client/locales/hu.json` | `DB41C82FCB05045C9E1E98F848DE2657C1296AD31833181AF52B3139154C47A6` | `DB41C82FCB05045C9E1E98F848DE2657C1296AD31833181AF52B3139154C47A6` |
| `vfs-client/locales/it.json` | `C57F3AF7DF20D66ACB23280616470497BF7E302B7DBF36CD1D06971FF717A5FC` | `C57F3AF7DF20D66ACB23280616470497BF7E302B7DBF36CD1D06971FF717A5FC` |
| `vfs-client/locales/ja.json` | `FEF7A3C12A714E51E748AEBADF47E9E045FB560F3D980AA3DDEED54C3B06BB7E` | `FEF7A3C12A714E51E748AEBADF47E9E045FB560F3D980AA3DDEED54C3B06BB7E` |
| `vfs-client/locales/nl.json` | `1DC9DB9B88AE69CE5627D8D70FC09ED3AE782404BAD673F459D3F48967C2A022` | `1DC9DB9B88AE69CE5627D8D70FC09ED3AE782404BAD673F459D3F48967C2A022` |
| `vfs-client/locales/pl.json` | `CD9B58C640AFB698AC0F69B74D853E7CB5B3DE961C76B6B7E96D8538999C40BB` | `CD9B58C640AFB698AC0F69B74D853E7CB5B3DE961C76B6B7E96D8538999C40BB` |
| `vfs-client/locales/pt.json` | `609046036B6A8EAEB2B2B87F2778CA6B412F647339E0FF1B9360B0C7E43F4DAE` | `609046036B6A8EAEB2B2B87F2778CA6B412F647339E0FF1B9360B0C7E43F4DAE` |
| `vfs-client/locales/ru.json` | `135445974363054187A52100D882995DB3CF1D2FC1112A1E656D950E6081235A` | `135445974363054187A52100D882995DB3CF1D2FC1112A1E656D950E6081235A` |
| `vfs-client/locales/sv.json` | `71140065A0528C22949781DD31A8DC2F89103C52EF5B80F2EAC96199158E43A7` | `71140065A0528C22949781DD31A8DC2F89103C52EF5B80F2EAC96199158E43A7` |
| `vfs-client/locales/zh_CN.json` | `20B309D382D7EAE6223A2DB1A54F8BE7DDA73F26A21AEE01919F29B873F9325D` | `20B309D382D7EAE6223A2DB1A54F8BE7DDA73F26A21AEE01919F29B873F9325D` |
| `vfs-client/locales/zh_TW.json` | `050785EE513CCB848C2EF173598D1B1BB4E3F73BADF5068653137FBD56E288DE` | `050785EE513CCB848C2EF173598D1B1BB4E3F73BADF5068653137FBD56E288DE` |
| `vfs-client/opfs-provider.mjs` | `2EC8C521071101624D39EC03E1F8D59DD0C0DC39C9CE564397DBE9B86B6A9F8B` | `2EC8C521071101624D39EC03E1F8D59DD0C0DC39C9CE564397DBE9B86B6A9F8B` |
| `vfs-client/picker.css` | `DA375628F769E336B74B4311130DE1324E8AE2221AC1A803776793DE3802A5F1` | `DA375628F769E336B74B4311130DE1324E8AE2221AC1A803776793DE3802A5F1` |
| `vfs-client/picker.html` | `7E2F34DCC449CBB9A9F6183B0E7221D1DE6D5A547303A174B34846DC27AB85C7` | `7E2F34DCC449CBB9A9F6183B0E7221D1DE6D5A547303A174B34846DC27AB85C7` |
| `vfs-client/picker.mjs` | `185A0AF304C3F176DAB42A96FB6A6A416AFA50F19B91B7C6CA9FB03E52799199` | `185A0AF304C3F176DAB42A96FB6A6A416AFA50F19B91B7C6CA9FB03E52799199` |
| `vfs-client/vfs-client.mjs` | `4ED076F703F7AB4A0E5E660094EA0A6954385FD3C7FD67C3DB0223ECB5B9561B` | `4ED076F703F7AB4A0E5E660094EA0A6954385FD3C7FD67C3DB0223ECB5B9561B` |
| `vfs-provider/vfs-provider.mjs` | `CDF9BED9683AF96505C2AAE8F3798CC3BD0D835388A8C9F908B17BF67596329D` | `CDF9BED9683AF96505C2AAE8F3798CC3BD0D835388A8C9F908B17BF67596329D` |
