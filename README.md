# apostrophe-multisite

## A work in progress

> This module requires Node 8. Your project must also have apostrophe as an npm dependency.

```javascript
const multi = require('apostrophe-multisite')({

  // For speed, make sure a site is live on this many processes,
  // on separate servers when possible. Processes are SHARED
  // by MANY sites, but setting this high still uses more RAM
  concurrencyPerSite: 2,

  // If we receive no new requests for a site in an hour,
  // let that apos object go, freeing up RAM in exchange for
  // a little extra spinup time on the next request
  timeout: 60 * 60,

  // We need to know what server/port combos are listening. This will
  // match your setup in mechanic/nginx or other load balancer. Can
  // also be space-separated in SERVERS env var

  servers: [ 'localhost:3000', 'localhost:3001', 'localhost:3002' ],
  // ... And which server we are. Can also be set
  // via SERVER env var
  
  server: 'localhost:3000',

  // Apostrophe configuration for your hosted sites.
  // Just one config for all of them; per-site config could be
  // user editable settings in apostrophe-global
  sites: {
    modules: {
      apostrophe-pages: {
        choices: [
          {
            label: 'Home',
            name: 'home'
          },
          {
            label: 'Default',
            name: 'default'
          }
        ]
      }
    }
  },

  // Apostrophe configuration for the dashboard site.
  // A `sites` module always exists, a piece that governs
  // multisite management and has a hostnames property
  dashboard: {
    modules: {
      // Further configure the pieces module that represents sites. Perhaps
      // you wish to add some custom fields in the usual way
      'sites': {
        addFields: [ ]
      }
    }
  }

});
```
