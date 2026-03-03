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
