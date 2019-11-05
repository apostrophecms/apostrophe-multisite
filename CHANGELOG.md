NOTE: see the STABILITY note in the README.

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

