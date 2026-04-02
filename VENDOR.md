# Third-Party Dependencies

## ical.js

- Package: `ical.js`
- Version: `2.2.1`
- Source: https://registry.npmjs.org/ical.js/-/ical.js-2.2.1.tgz
- Upstream repository: https://github.com/kewisch/ical.js
- Included file: `vendor/ical.js` (UMD/CJS distribution from `dist/ical.es5.cjs`)
- License: MPL-2.0
- Usage in this add-on:
  - iCalendar parsing/writing contract in `modules/icalContract.js`
  - Runtime consumers:
    - `modules/bgCalendar.js`
    - `modules/talkcore.js`

## DOMPurify

- Package: `dompurify`
- Version: `3.3.1`
- Source: https://raw.githubusercontent.com/cure53/DOMPurify/3.3.1/dist/purify.js
- Upstream repository: https://github.com/cure53/DOMPurify
- Included file: `vendor/purify.js` (browser distribution from `dist/purify.js`)
- License: Apache-2.0 OR MPL-2.0
- Usage in this add-on:
  - Client-side sanitization of backend-provided Talk invitation HTML
  - Client-side sanitization of backend-provided Share/Password HTML templates
  - Runtime consumers:
    - `modules/htmlSanitizer.js`
    - `modules/bgRouter.js`
    - `modules/ncSharing.js`
    - `ui/talkDialog.js`
