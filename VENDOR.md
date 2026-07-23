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
    - `modules/talkcore.js`

## DOMPurify

- Package: `dompurify`
- Version: `3.4.11`
- Source: https://registry.npmjs.org/dompurify/-/dompurify-3.4.11.tgz
- Upstream repository: https://github.com/cure53/DOMPurify
- Included file: `vendor/purify.js` (browser distribution from `dist/purify.js`)
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
