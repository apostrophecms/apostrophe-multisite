# apostrophe-multisite

[![CircleCI](https://circleci.com/gh/apostrophecms/apostrophe-multisite.svg?style=svg)](https://circleci.com/gh/apostrophecms/apostrophe-multisite)

## What's it do?

This module lets you have many ApostropheCMS websites running on a single codebase in a single Node.js process. Each has its own database, users, media uploads, etc. Sites can be created and managed via a dashboard site.

Those using this module are [strongly advised to join our Apostrophe Enterprise Support program](https://apostrophecms.org/support/enterprise-support). We can work with you to make sure your customers receive the high availability and durability this module is designed to provide.

Note: you **do not** need this module in most Apostrophe projects. It is designed to support projects that require many independently edited sites with the same source code and configuration.

## Requirements (Node 10 or better)

You must have a currently supported release of Node.js, which would be 10.x or better as of this writing.

Your project must also have `apostrophe` as an npm dependency.

## Sample `app.js`

```javascript
const multi = require('apostrophe-multisite')({

  // Port to listen on, or set the `PORT` env var (which Heroku will do for you)
  port: 3000,

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

  // This is our default HTTP Keep-Alive time, in ms, for reuse of
  // connections. Should be longer than that of the reverse proxy
  // (nginx: 75 seconds, AWS ELB: 60 seconds, etc)
  keepAliveTimeout: 100 * 1000,

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
  // There is no top level await so we catch this here.
  // At this point either the task is running or the site is up.
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
  mongodbUrl: 'mongodb://somewhere-else:27017',
  dashboardHostname: [ 'dashboard-prod.myservice.com' ]
};
```

You should exclude this file from deployment so it can be different on staging and production servers, as opposed to local dev environments.

> Your hosted sites share `sites/data/local.js`, and your dashboard site can have `dashboard/data/local.js`. They do not read the top-level `data/local.js`, it is exclusively for the multisite module. All three folders should be excluded from deployment.

**Or, you can use environment variables as enumerated above in the example configuration.** This is the only way to go with a host like Heroku that does not offer persistent storage on the local drive.

> If you simply use a load balancer to point to several processes or servers running `apostrophe-multisite`, you will eventually have `apos` objects live for every site that is accessed in each process. This is fine, generally speaking, but if you have thousands of sites it would make more sense to configure your load balancer to only send site X to servers A, B, and C (to provide some redundancy), and so forth. However that is a load balancer configuration task outside the scope of this module.

## Creating sites via the dashboard

First you need to be able to log into the dashboard:

```
node app apostrophe-users:add admin admin --site=dashboard
```

Now log into `http://dashboard:3000`.

Then, go to the admin bar, pick "Sites", and add a site, giving it one of the hostnames you added to `/etc/hosts`. Let's say the hostname is `one`.

> Remember that you'll need to add staging and production hostnames here too at some point.

Now you can access:

`http://one:3000`

But, you still don't have any users for `one`. So make a user there:

```
node app apostrophe-users:add admin admin --site=one
```

## Staging and production deployment

See the [apostrophe-multisite-demo](https://github.com/apostrophecms/apostrophe-multisite-demo) project for stagecoach deployment scripts, and content sync scripts.

Load-balance between cores and/or servers in the usual way, we typically do it with nginx and mechanic. You will want to make sure this nginx `server` block is set as the default so it gets the traffic for all the sites being added.

## How to run tasks

To run a task for the dashboard site:

```
node app apostrophe-migrations:migrate --site=dashboard
```

To run a task for an individual site, by its hostname or `_id`:

```
node app apostrophe-migrations:migrate --site=example.com
```

To run a task for all hosted sites (not the dashboard):

```
node app apostrophe-migrations:migrate --all-sites
```

To run that task without forking a new process for each invocation, which works only with well-behaved tasks that don't try to exit the process on their own:

```
node app apostrophe-migrations:migrate --all-sites --without-forking --concurrency=3
```

This significantly improves performance. The appropriate level of `concurrency` depends on your task; you may leave this argument off.

> We do fork just a little. To combat memory leaks observed when running under Linux, if there are more than ten sites to run the task for, sub-processes will be forked to process them sequentially in groups of 10 using the `--sites` option. The end result is the same, and `concurrency` still applies within each group.

To run a task on a temporary "hosted" site which will be deleted after the task:

```
node app apostrophe:generation --temporary-site
```

> `--temporary-site` is good for generating assets that are shared between the hosted sites, but not the dashboard. Note that `--temporary-site` and `--all-sites` do not work for interactive tasks that prompt for information, like `apostrophe-users:change-password`, or otherwise read from standard input. Currently these options print all output at the end.

If the site objects in your dashboard have a `theme` schema field (typically of type `select`), then you may generate assets for each theme:

```
node app apostrophe:generation --temporary-site --theme=theme-one
node app apostrophe:generation --temporary-site --theme=theme-two
```

> For a complete solution to generate per-theme assets you will also need to override the `getThemeName` method of `apostrophe-assets` [as shown here](https://github.com/apostrophecms/apostrophe-multisite/tree/document-theme-assets#separate-frontend-assets-for-separate-themes).

## Running scheduled tasks just once across a cluster

You may have multiple application servers or workers which could potentially run each task, and need them to run, for instance, only once per hour. You need them to run only once even if you have many servers.

You can do that by configuring cron jobs like this across all servers. These cron jobs don't call out the specific tasks, they just provide a point of entry:

```
0 0 * * * ( cd /opt/stagecoach/apps/my-app/current && node app tasks --frequency=daily )
0 * * * * ( cd /opt/stagecoach/apps/my-app/current && node app tasks --frequency=hourly )
```

Now configure the top-level `tasks` option, which is a peer of `sites` and `dashboard`, it is not nested within them:

```
tasks: {
  // These tasks are run for all sites, i.e. like the `--all-sites` option
  'all-sites': {
    hourly: [
      // Run this task hourly but only on the server that
      // happens to grab the lock first
      'products:sync'
    ],
    daily: [ ... also supported ]
  },
  // These tasks are run for the dashboard site, i.e. like `--site=dashboard`
  dashboard: {
    hourly: [
      'some-module-name:some-task-name'
    ],
    daily: [ ... also supported ]
  }
}
```

This way your crontab file doesn't have to contain any
custom state. It just contains these standard entries and
your configuration in `app.js` determines what tasks are run,
leveraging cron only as a way to begin invocation at the
right time.

Apostrophe will use locks and check the most recent start
time to avoid redundancy.

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

## Is there a way to customize per-site configuration as if they had their own `app.js`?

Yes. If the `sites` option is a function rather than an object, it is invoked with the `site` object, and must return an object.

This allows you to take the properties of the dashboard’s `site` object into account when the site “spins up.”

In addition, any time a `site` piece is saved in the dashboard, all existing `apos` objects for that site are invalidated, meaning that they will be created anew on the next web request. This allows the `options.sites` function to take the new properties of `site` into account.

This can be used to achieve effects such as passing a new list of locales to `apostrophe-workflow` based on user input in the dashboard.

Note that this means the `site` object should not be updated frequently or for trivial reasons via Apostrophe’s `update` method — only when significant configuration changes occur. However, it is never a good idea in any case to implement a hit counter via Apostrophe’s model layer methods. As always, use a direct MongoDB `update` with `$inc` for such purposes.

## Separate frontend assets for separate themes

There is one limitation to per-site configuration: **the sites function must always result in the same set of assets being pushed by the modules, except if the decision is made based on a `theme` property of each site object.** If you add a `theme` field to the `sites` pieces module in the dashboard, you may use logic based on `site.theme` in the sites function to decide which modules will be included in the project, even if this changes the assets.

In addition, **to produce a different asset bundle for each theme, you must override the `getThemeName` method of the `apostrophe-assets` module for your sites.** This function must return the theme name associated with your site.

Here is a working example.

```javascript
// in app.js
sites(site) => {
  return {
    // Pass the theme name in as a global option to the apos object. If you
    // add support for themes later in your project, make sure you provide
    // a default theme name for old sites
    theme: site.theme || 'default',
    modules: {
      // Other configuration here. Include various modules, or not,
      // based on `site.theme`
    }
  };
}

// in sites/lib/modules/apostrophe-assets/index.js
module.exports = {
  construct(self, options) {
    self.getThemeName = () => {
      return self.apos.options.theme;
    };
  }
};
```

## Using AWS (or Azure, etc.)

You can achieve this by passing [uploadfs](https://github.com/punkave/uploadfs) settings to the `apostrophe-attachments` module for both `dashboard` and `sites`, or just set these environment variables when running the application:

```
APOS_S3_BUCKET YOUR-bucket-name
APOS_S3_SECRET YOUR-s3-secret
APOS_S3_KEY YOUR-s3-key
APOS_S3_REGION YOUR-chosen-region
```

`apostrophe-multisite` will automatically add a distinct prefix to the paths for each individual site's assets.

## Deployment issues

You need to persist `data`, `sites/data`, `dashboard/data`, `sites/public/uploads`, and `dashboard/public/uploads` between deployments. See the [apostrophe-multisite-demo](https://github.com/apostrophecms/apostrophe-multisite-demo) project.

## Logging

By default only warnings and errors are logged when `NODE_ENV` is `production`. In development, everything islogged by default.

To log everything in production, set the VERBOSE environment variable:

```
VERBOSE=1 node app
```

You can also select one or more of the four possible logging levels:

```
LOG_LEVEL=info,debug,warn,error node app
```

`info` and `debug` are written to standard output, while `warn` and `error` are written to standard error. When not running a command line task on behalf of a single site, the output is prefaced with the shortname of the site responsible. TODO: provide options to replace this simple logger.

## Setting `baseUrl` and naming environments

By default, `sites` come with three url fields in their schema that correspond to three server environments: `dev`, `staging`, and `prod`. From the Dashboard, you are able to set the `baseUrl` property of each site within each environment.

Or, you can add a configuration in the dashboard that maps all sites to subdomains of certain working domains, one for dev, one for staging, and one for prod:

```javascript
// app.js
require('apostrophe-multisite')({
  dashboard: {
    modules: {
      'sites': {
        baseUrlDomains: {
          dev: 't:3000',
          staging: 'test.dev',
          prod: 'test.com'
        },
      },
    }
  }
}).then(function (result) {
  // There is no top level await so we catch this here.
  // At this point either the task is running or the site is up.
}).catch(function (err) {
  console.error(err);
  process.exit(1);
});

```

> It is essential to add the port number you plan to test on to your `dev` entry in `baseUrlDomains`, as shown above.

This way, the three url fields (dev, staging, and prod) will not be part of the site's schema but two other fields will appear: shortname and production hostname. The shortname will be added to the baseUrlDomains and hostnames will be inferred from this. For instance, if the shortname is `shortname`, the staging environment would be `shortname.test.dev` in the example above. If the production hostname is filled in, it will replace `test.com`. The production hostname will also be duplicated in the hostnames array (one version with `www.`, one version without) so that both names work.

If sites were created using the default method, after having added the `baseUrlDomains` config, it is possible to run the task `node app sites:transition-shortname --site=dashboard` to fill shortname for each site base on the first hostname if it existed.

To let `apostrophe-multisite` know what environment it is currently running in, add the property `env` to your server's `data/local.js` file.

```
module.exports = {
  env: 'prod'
}
```

Or add it as an environment variable when starting up your app.

`ENV=prod node app.js`

You can create your own environment names by adding url fields to your `sites` piece type and naming them like this:

`myEnvBaseUrl` or `staging2BaseUrl`

The `ENV` environment variable determines which environment will be used. If it is `prod` for example, the url used will be the one defined in the schema or in the sites configuration for `prod`.

## Resource leak mitigation

If you suspect your application is slowly leaking memory, HTTP sockets or some other resource that eventually renders it nonresponsive, you can set the `maxRequestsBeforeShutdown` option. The application will automatically exit after that number of requests. By default, this mechanism calls `process.exit(0)`. You can change this behavior by passing a custom `exit` function to `apostrophe-multisite` as an option.

`10000` is a reasonable value for this option.

Of course this assumes you are using `pm2`, `forever` or another mechanism to restart the application when it exits, and that you are also running at least one other process concurrently, so that they can cover for each other during restarts.

To avoid 502 Bad Gateway errors when all of the processes stop at the same time, for instance due to round robin scheduling that delivers equal numbers of requests to them, a random number of additional requests between 0 and 1000 are accepted per process. This can be adjusted via the `additionalRequestsBeforeShutdown` option; set to 0 for no random factor at all.

## Project contribution

### Run tests

Tests can be run locally if hosts are on your machine with `sudo nano /etc/hosts` on Linux or MacOs.
Add this line to the `/etc/hosts` file: `127.0.0.1 dashboard.test site.test site2.test` and save.

If modification of the hosts file is not an option, tests can be run through Docker by installer Docker and docker-compose. Then, run `docker-compose up`. By default, it will launch `npm test`. You can also add a `TEST_CMD` variable to launch another command. For example, `TEST_CMD='npm run test:watch' docker-compose up` to launch tests in watch mode and reload tests as you modify them.

### Code linting

When contributing to this project, run `npm run lint` before pushing code in order to facilitate code review.
