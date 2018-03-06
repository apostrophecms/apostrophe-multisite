# apostrophe-multisite

## A work in progress

> This module requires Node 8. Your project must also have apostrophe as an npm dependency.

```javascript
const multi = require('apostrophe-multisite')({

  // An API key is required for interserver communication.
  // Make it unique and secure, do not use this value
  apiKey: 'CHANGE-ME',

  // For speed, make sure a site is live on this many processes,
  // on separate servers when possible. Processes are SHARED
  // by MANY sites, but setting this high still uses more RAM
  concurrencyPerSite: 1,

  // If we receive no new requests for a site in an hour,
  // let that apos object go, freeing up RAM in exchange for
  // a little extra spinup time on the next request
  timeout: 60 * 60,

  // We need to know what server/port combos are listening. This will
  // match your setup in mechanic/nginx or other load balancer. Can
  // also be space-separated in SERVERS env var

  servers: [ 'localhost:3000' ],

  // ... And which server we are. Can also be set
  // via SERVER env var  
  server: 'localhost:3000',

  shortNamePrefix: process.env.SHORTNAME_PREFIX || 'multisite-',

  // MongoDB URL for database connection. If you have multiple physical
  // servers then you MUST configure this to a SHARED server (which
  // may be a replica set). Can be set via MONGODB_URL env var
  mongodbUrl: 'mongodb://localhost:27017',

  // Hostname of the dashboard site. Distinct from the hosted sites.
  dashboardHostname: 'dashboard',

  // Session secret. Please use a unique string.
  sessionSecret: 'thisismadeup',

  // Apostrophe configuration for your hosted sites.
  // Just one config for all of them; per-site config could be
  // user editable settings in apostrophe-global.
  // You can also do much more in `sites/lib/modules`,
  // following Apostrophe's usual patterns

  sites: {
    modules: {
      'apostrophe-users': {
        groups: [
          {
            title: 'admin',
            permissions: [ 'admin' ]
          }
        ]
      },
      'apostrophe-pages': {
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
  // multisite management and has a hostnames property.
  // You can also do much more in `dashboard/lib/modules`,
  // following Apostrophe's usual patterns

  dashboard: {
    modules: {
      'apostrophe-users': {
        groups: [
          {
            title: 'admin',
            permissions: [ 'admin' ]
          }
        ]
      },
      // Further configure the pieces module that represents sites. Perhaps
      // you wish to add some custom fields in the usual way
      'sites': {
        addFields: [ ]
      }
    }
  }
}).then(function(result) {
  if (result === 'task') {
    console.log('Running task...');
  } else {
    // top level await is not a thing, so handle the promise
    console.log('Running...');
  }
}).catch(function(err) {
  console.error(err);
  process.exit(1);
});

```
