# apostrophe-multisite

## A work in progress

## Requirements (Node 8 is REQUIRED)

This module requires Node 8. Your project must also have `apostrophe` as an npm dependency.

Hint: use `nvm` if you aren't ready to change to node 8 in your dev environment.

## Sample `app.js`

```javascript
const multi = require('apostrophe-multisite')({

  // An API key is required for interserver communication.
  // Make it unique and secure, do not use this value
  apiKey: 'CHANGE-ME',

  // For speed, make sure a site is live on this many processes,
  // on separate servers when possible. Processes are SHARED
  // by MANY sites, but setting this high still uses more RAM.
  // Can also be CONCURRENCY_PER_SITE env var
  concurrencyPerSite: 1,

  // If we receive no new requests for a site in an hour,
  // let that apos object go, freeing up RAM in exchange for
  // a little extra spinup time on the next request
  timeout: 60 * 60,

  // We need to know what server/port combos are listening. This will
  // match your setup in mechanic/nginx or other load balancer. Can
  // also be comma-separated in SERVERS env var

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
  // May also be a comma-separated list, or an array. May be set via
  // the DASHBOARD_HOSTNAME environment variable.
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

## Running in dev: mapping hostnames to your own computer

Each site needs a unique hostname, so you will need to edit `/etc/hosts` much as you would for developing PHP sites locally, adding a line like this:

```
127.0.0.1 dashboard one two three four
```

Now you can access `http://dashboard:3000` to visit the dashboard site, or `http://one:3000` to access site `one` (if you actually add a site with that hostname to the dashboard), etc.

A site can have multiple hostnames, so you can accommodate real DNS names for staging and production too, if you are syncing things around. Of course, we need to write sync scripts that can actually handle moving multiple databases for you first.

## Running in production: server-specific settings

Sometimes you'll need to change certain options for production use.

You can use a `data/local.js` file, like this. It **merges automatically with your configuration, do not require the file yourself**:

```javascript
module.exports = {
  concurrencyPerSite: 5
};
```

You should exclude this file from deployment so it can be different on staging and production servers, as opposed to local dev environments.

Your hosted sites share `sites/data/local.js`, and your dashboard site can have `dashboard/data/local.js`. They do not read the top-level `data/local.js`, it is exclusively for the multisite module. All three folders should be excluded from deployment.

**Or, you can use environment variables as enumerated above in the example configuration.** This is the only way to go with a host like Heroku that does not offer persistent storage on the local drive.

## Creating sites via the dashboard

First you need to be able to log into the dashboard:

```
node app apostrophe-users:add admin admin --site=dashboard
```

Now log into `http://dashboard:3000`.

Then, go to the admin bar, pick "Sites", and add a site, giving it one of the hostnames you added to `/etc/hosts`. Let's say the hostname is `one`.

Now you can access:

`http://one:3000`

But, you still don't have any users for `one`. So make a user there:

```
node app apostrophe-users:add admin admin --site=one
```

## Staging and production deployment

TODO: deployment scripts.

TODO: content sync scripts.

TODO: automated mechanic/nginx setup script. However you can use mechanic manually to add all of the hostnames and forward them to the same port(s), because a single process (or group of processes, one per core as usual) can serve all of the sites. `apostrophe-multisite` is a proxy in its own right, but you still want `mechanic` handling port 80 and fast static file delivery etc.

## How to run tasks

To run a task for the dashboard site:

```
node app apostrophe-migrations:migrate --site=dashboard
```

To run a task for an individual site, by its hostname or _id:

```
node app apostrophe-migrations:migrate --site=example.com
```

To run a task for all hosted sites (not the dashboard):

```
node app apostrophe-migrations:migrate --all-sites
```

To run a task on a temporary "hosted" site which will be deleted after the task:

```
node app apostrophe:generation --temporary-site
```

> `--temporary-site` is good for generating assets that are shared between the hosted sites, but not the dashboard. Note that `--temporary-site` and `--all-sites` do not work for interactive tasks that prompt for information, like `apostrophe-users:change-password`, or otherwise read from standard input. Currently these options print all output at the end.

## Code and templates for the hosted sites

These live in `sites/lib/modules` of your project.

## Code and templates for the dashboard site

These live in `dashboard/lib/modules` of your project. Be aware that there is already a pieces module called `sites`, which powers the proxy that routes traffic to the individual sites. You can extend that module with more fields.

## "But where do I configure the individual sites?"

The entire point of this module is to share all of the code between sites. If we didn't want that, we'd build and deploy separate sites and we wouldn't need this module.

So if you are using this approach, then all configuration that varies between sites must take place via the user interface.

For instance, you might use the `apostrophe-palette` module, or just use `apostrophe-global` preferences for high level choices like site-wide styles or Google Analytics IDs, as documented on the Apostrophe website.

"How can I mirror certain properties between apostrophe-global of individual sites and the `site` piece in the dashboard, so they both can see that stuff?"

TODO.
