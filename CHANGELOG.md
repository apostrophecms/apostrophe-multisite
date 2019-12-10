NOTE: see the STABILITY note in the README.

# 2.2.1

* Set protocol properly for `prodBaseUrl` when `prodHostname` is set.

# 2.2.0

* The object returned by `apostrophe-multisite` now has `getSiteApos`, `dashboard` and `server` properties.
* A suite of tests is now included. These tests require specific entries in `/etc/hosts` (see the README) or you can use the provided Docker files to run them.

# 2.1.1

Fixed an oversight that would crash if the site had no shortName or slug yet in beforeSave (this issue existed briefly in 2.1.0).

# 2.1.0

The new `baseUrlDomains` option provides a friendly alternative to the current confusing system of `devBaseUrl`, `stagingBaseUrl`, `prodBaseUrl` and `hostnames` fields. These properties still exist "under the hood," but are configured automatically based solely on a "short name" and, when the time comes, a "production hostname" provided by the admin. `baseUrlDomains` can have three properties: `dev`, `staging`, and `prod`. These are the domains to use in each of those three environments, as determined by the `ENV` environment variable. If the short name is `nifty`, `ENV` is `dev`, and the `dev` subproperty of `baseUrlDomains` is set to `t:3000`, the hostname will be `nifty.t` and URLs will include port 3000. If the short name is `nifty`, `ENV` is `staging`, and the `staging` subproperty of `baseUrlDomains` is set to `staging-platform.com`, the short name is `nifty.staging-platform.com` and there is no port number in the URL. When using this system staging and production always automatically include `https` in their URLs.

# 2.0.7

You can now schedule simple daily and hourly Apostrophe command line tasks across a cluster without encountering duplicate execution. See the README for details.

# 2.0.6

* The databases associated with temporary sites created via the `--temporary-site` option to run a command line task are now dropped properly after the task completes. You may find you have quite a few of these databases kicking around. These can be cleaned up using `node app sites:remove-orphans --site=dashboard`. You should `mongodump` the entire system first as a backup.

# 2.0.5

* The `theme` property can be injected into a temporary `site` object via the `--theme` command line option, when used together with `--temporary-site`. This is not the full-blown theme support you are waiting for. Real theme support will likely be arriving as we backport from a relevant project.

# 2.0.4

* Make sure `dashboard` can be seen early enough in `spinUp` if a site is spun up by the dashboard before its own spinup is 100% complete, for instance as part of a command line task's execution.
* Asset generation override for dev is simpler now.

# 2.0.3

* No mixed content warnings breaking stylesheets on dashboard. Same rule already applied to sites: `https: true` for uploadfs.

# 2.0.2

* Improved handling of cloud deployments. The instance sites share a collection for purposes of the `APOS_BUNDLE=1` asset bundling feature.

# 2.0.1

* Site fields grouped properly.

# 2.0.0

Initial release. Normally we would have numbered this 0.1.0, but due to an oversight it was released with a 2.x version number. See the STABILITY note in the README.

