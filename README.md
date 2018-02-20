# apostrophe-multisite

## A work in progress

```javascript
const multi = require('apostrophe-multisite')({

  // For speed, make sure a site is live on this many processes,
  // on separate servers when possible. Setting this high
  // uses more RAM
  concurrencyPerSite: 2,
  // If we receive no new requests for a site in an hour,
  // let that apos object go, freeing up RAM in exchange for
  // a little extra spinup time on the next request
  timeout: 60 * 60,
  // We need to know what servers exist, if more than one
  servers: [ 'frontend-1.example.com', 'frontend-2.example.com', 'frontend-3.example.com' ],
  // ... And which server we are. Can also be set
  // via `data/local.js` or APOS_MULTI_SERVER env var
  server: 'frontend-1.example.com',

  // Apostrophe configuration for your hosted sites.
  // Just one config for all of them; per-site config could be
  // user editable settings in apostrophe-global
  sites: {
    modules: {
      apostrophe-blog: { ... }
    }
  },

  // Apostrophe configuration for the dashboard site.
  dashboard: {
    modules: {
      // A pieces module that represents sites. Perhaps
      // you add some custom fields in the usual way
      'apostrophe-multisite-sites': {
        addFields: [ ... plan name, billing stuff... ]
      }
    }
  }

});
```
