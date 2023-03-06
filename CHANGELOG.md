# Changelog

## 2.11.2 (2023-03-06)

- Removes `apostrophe` as a peer dependency.

## 2.11.1 (2021-06-02)

* Fix crash on missing Host field.
* When copying a site's database with mongorestore, explicitly use `--nsInclude=*` as some versions of mongorestore will restore nothing without it.

## 2.11.0 (2021-05-19)

* Mixed-case values for `shortName` and `prodHostname` are now normalized to lower case. Without this they do not match any web requests, resulting in a `notfound` message. A migration is included to take care of this in existing databases.

## 2.10.0

* Copying sites: starting with MongoDB server version 4.2, the `copydb` command is no longer supported, so we use a `mongodump | mongorestore` pipeline instead. For maximum backwards compatibility we don't do this unless we have to (MongoDB server version is 4.2 or greater). You should make sure up to date versions of these utilities are installed in the PATH for future compatibility.

## 2.9.0

* `destroy` method for the multisite object shuts down everything. Used for clean termination of mocha tests and verification that `apos.destroy` does its job too.
* Properly catch and report errors when initializing a site's `apos` object.

## 2.8.1

* Canonicalization of the domain name now occurs only when the `ENV` environment variable is set to `prod`. This prevents confusing directs in dev and staging environments when the dashboard database has been copied down from prod.

## 2.8.0

* Support for canonicalization of the domain name. Once a site's DNS has been set up for the production hostname and HTTPS is in place, etc., a dashboard admin can select this option to redirect all traffic from the "work in progress" domain to the final production one. This helps prevent confusion after login when links on the site take you to a logged-out view on a different domain. Only available when the `baseUrlDomains` option is set.

## 2.7.0

* Support for sitewide redirects. This is handy when retiring a site, or taking responsibility for redirecting additional domains (you can them as sites and immediately set up redirects).

## 2.6.4

* Command line tasks should not generate assets, unless the task being run is the actual `apostrophe:generation` task. The `--without-forking` option often used together with `--all-sites` now respects this rule for much faster execution of tasks like `apostrophe-migrations:migrate` across all sites. Note that to avoid wasted time and resources `apostrophe:generation` is typically run just once, for a temporary site, or once per theme.

## 2.6.3

* More documentation revisions.

## 2.6.2

* Updated README to reflect the production stability of the module.

## 2.6.1

* In order to work around memory leaks observed in some environments during `apostrophe-migrations:migrate` runs with the `--without-forking` option, if there are more than ten sites groups of ten sites at a time are run this way in a subprocess. This allows some benefit from process reuse without hitting memory limits.
* The `listDatabases` mongodb command is now called with `nameOnly: true` to greatly improve the speed with which it returns.
* All tests pass again.

## 2.6.0

* Bumped dependency on emulate-mongo-2-driver to 1.1.0 or better to reflect the substantial benefits of mongodb+srv URIs and a lack of deprecation warnings. Connects with `useUnifiedTopology: true`.

## 2.5.0

* `maxRequestsBeforeShutdown` option added. This causes the entire process to shut down gracefully after the specified number of requests (10000 is a reasonable choice). This is a good pragmatic technique to address resource leaks. Of course you must have pm2, forever or another mechanism in place to restart the process.
* eslint compliant
* eslint now required for test passage

## 2.4.3

* Removed a few very noisy logging calls that were made obvious by 2.4.2, and began invoking trim() on log messages as some of Apostrophe's whitespace-padded messages do not ready well in the presence of a sitename prefix.
## 2.4.2

* 2.4.0 introduced a new logger that distinguishes the output of the various sites, which is a good thing, and also does not output `apos.utils.log/apos.utils.info` or `apos.utils.debug` calls by default, which is good for production but bad for development. In 2.4.2 this was revised: if `NODE_ENV` is not `production`, the default is to log all output. Note that setting `NODE_ENV` to `production` is a widely followed best practice for servers. You can still set `VERBOSE=1` to override this, or set `LOG_LEVELS` to any comma-separated combination of `info`, `debug`, `warn` and `error`.

## 2.4.1

* 2.4.0 introduced a regression that broke `--temporary-site`. Fixed.

## 2.4.0

* When running a task with `--all-sites`, you can optionally add `--without-forking` to avoid the overhead of forking a separate node process for each site, as long as the task in question is well-behaved and does not attempt to exit the process by itself. This improves performance. You can also use `--concurrency=3` to run the task for three sites simultaneously, which can also help performance depending on the task. `--concurrency` has no effect without `--without-forking`. With numerous sites in play, the `apostrophe-migrations:migrate` task completes about 3x faster with `--without-forking --concurrency=3`, although the benefit of `--concurrency=3` is smaller than you might think.

## 2.3.1

* Set server.keepAliveTimeout to 100 seconds by default, and provide an option to override. The default of Node.js is 5 seconds, which is shorter than that of most reverse proxies and also just about right to cause problems for Apostrophe's notification long polls, leading to a race condition and mysteriously stuck or dropped requests. See: https://shuheikagawa.com/blog/2019/04/25/keep-alive-timeout/

## 2.3.0

* Dependencies updated to require at least version 2.101.0 of ApostropheCMS. This was done to ensure no npm audit vulnerabilities.

## 2.2.3

* Exit with a nonzero status code if a task run via `--all-sites` or `--temporary-site` exits with a nonzero status code. Also exit with a nonzero status code if such a task exits due to a signal.

## 2.2.2

* Do not permit entry of whitespace in the `shortName` schema field of sites, which is invalid and can cause problems down the road for proxy scripts.

## 2.2.1

* Set protocol properly for `prodBaseUrl` when `prodHostname` is set.

## 2.2.0

* The object returned by `apostrophe-multisite` now has `getSiteApos`, `dashboard` and `server` properties.
* A suite of tests is now included. These tests require specific entries in `/etc/hosts` (see the README) or you can use the provided Docker files to run them.

## 2.1.1

Fixed an oversight that would crash if the site had no shortName or slug yet in beforeSave (this issue existed briefly in 2.1.0).

## 2.1.0

The new `baseUrlDomains` option provides a friendly alternative to the current confusing system of `devBaseUrl`, `stagingBaseUrl`, `prodBaseUrl` and `hostnames` fields. These properties still exist "under the hood," but are configured automatically based solely on a "short name" and, when the time comes, a "production hostname" provided by the admin. `baseUrlDomains` can have three properties: `dev`, `staging`, and `prod`. These are the domains to use in each of those three environments, as determined by the `ENV` environment variable. If the short name is `nifty`, `ENV` is `dev`, and the `dev` subproperty of `baseUrlDomains` is set to `t:3000`, the hostname will be `nifty.t` and URLs will include port 3000. If the short name is `nifty`, `ENV` is `staging`, and the `staging` subproperty of `baseUrlDomains` is set to `staging-platform.com`, the short name is `nifty.staging-platform.com` and there is no port number in the URL. When using this system staging and production always automatically include `https` in their URLs.

## 2.0.7

You can now schedule simple daily and hourly Apostrophe command line tasks across a cluster without encountering duplicate execution. See the README for details.

## 2.0.6

* The databases associated with temporary sites created via the `--temporary-site` option to run a command line task are now dropped properly after the task completes. You may find you have quite a few of these databases kicking around. These can be cleaned up using `node app sites:remove-orphans --site=dashboard`. You should `mongodump` the entire system first as a backup.

## 2.0.5

* The `theme` property can be injected into a temporary `site` object via the `--theme` command line option, when used together with `--temporary-site`. This is not the full-blown theme support you are waiting for. Real theme support will likely be arriving as we backport from a relevant project.

## 2.0.4

* Make sure `dashboard` can be seen early enough in `spinUp` if a site is spun up by the dashboard before its own spinup is 100% complete, for instance as part of a command line task's execution.
* Asset generation override for dev is simpler now.

## 2.0.3

* No mixed content warnings breaking stylesheets on dashboard. Same rule already applied to sites: `https: true` for uploadfs.

## 2.0.2

* Improved handling of cloud deployments. The instance sites share a collection for purposes of the `APOS_BUNDLE=1` asset bundling feature.

## 2.0.1

* Site fields grouped properly.

## 2.0.0

Initial release. Normally we would have numbered this 0.1.0, but due to an oversight it was released with a 2.x version number. See the STABILITY note in the README.

