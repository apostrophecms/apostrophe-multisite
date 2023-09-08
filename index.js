const _ = require('lodash');
const mongo = require('emulate-mongo-2-driver');
const fs = require('fs');
const argv = require('boring')();
const Promise = require('bluebird');
const uploadfs = require('uploadfs');
const mkdirp = require('mkdirp');
const util = require('util');
const createHttpTerminator = require('http-terminator').createHttpTerminator;
const enableDestroy = require('server-destroy');

module.exports = async function(options) {
  const self = {};
  // apos objects by site _id
  const aposes = {};
  const aposUpdatedAt = {};
  const multisiteOptions = options;
  let requests = 0;
  let additionalRequestsBeforeShutdown;
  // Allows process.exit to be mocked out for tests
  const exit = options.exit || function(code) {
    return process.exit(code);
  };

  // Public API

  // Returns a promise for an `apos` object for the given site
  // based on its `site` object in the dashboard.
  //
  // If present, `options` is merged with the options object
  // passed to initialize Apostrophe. This argument is typically
  // used to prevent `argv` from being reused.

  self.getSiteApos = async function(siteOrId, options) {
    let site = siteOrId;
    if ((typeof siteOrId) === 'string') {
      site = await dashboard.docs.db.findOne({
        type: 'site',
        _id: siteOrId,
        // For speed and because they can have their own users and permissions
        // at page level, which works just fine, we do not implement the entire
        // Apostrophe permissions stack with regard to the site object before
        // deciding whether to proxy to it.
        //
        // However, we do make sure the site is published and not in the trash,
        // to keep things intuitive for the superadmin.
        trash: { $ne: true },
        published: true
      });
    }
    return Promise.promisify(body)();
    function body(callback) {
      // This would be very simple with await, but for some reason
      // it gets a premature return value of undefined from spinUp. Shrug.
      function attempt() {
        if (aposes[site._id] === 'pending') {
          setTimeout(attempt, 100);
          return;
        }
        if (aposes[site._id] && (aposUpdatedAt[site._id] < site.updatedAt)) {
          // apos object is older than site's configuration
          const apos = aposes[site._id];
          aposes[site._id] = null;
          return apos.destroy(function() {
            // Don't forget to try again
            attempt();
          });
        }
        if (!aposes[site._id]) {
          return spinUp(site, options).then(function(apos) {
            aposUpdatedAt[site._id] = site.updatedAt;
            aposes[site._id] = apos;
            return callback(null, aposes[site._id]);
          }).catch(function(e) {
            delete aposes[site._id];
            return callback(e);
          });
        }
        return callback(null, aposes[site._id]);
      }
      attempt();
    }
  };

  self.destroy = async function() {
    enableDestroy(self.server);
    self.server.destroy();
    for (const [ key, apos ] of Object.entries(aposes)) {
      if ((typeof apos) === 'object') {
        await Promise.promisify(apos.destroy)();
        delete aposes[key];
      }
    }
    await Promise.promisify(dashboard.destroy)();
    if (self.janitorInterval) {
      clearInterval(self.janitorInterval);
    }
    await db.close();
  };

  // Implementation

  let local = {};
  if (fs.existsSync(getRootDir() + '/data/local.js')) {
    local = require(getRootDir() + '/data/local.js');
  }
  _.defaultsDeep(local, options, {
    // Listen on this port unless the PORT env var is set
    port: 3000,
    // Express route executed if a request comes in for a hostname that
    // is not present in the sites database
    orphan: function(req, res) {
      res.status(404).send('not found');
    },
    // Session secret used for all of the sites
    sessionSecret: process.env.SESSION_SECRET,
    // Prefix, used primarily for database names. If you have
    // several multisite configurations going on (multiception!)
    // you'll need to make this unique for each collection of sites
    shortNamePrefix: 'multisite-',
    // MongoDB URL for database connection. If you have multiple physical
    // servers then you MUST configure this to a SHARED server (which
    // may be a replica set)
    mongodbUrl: 'mongodb://localhost:27017',
    root: getRoot()
  });
  options = local;

  if (process.env.SERVER) {
    // Legacy, process.env.PORT is plenty for our needs
    options.server = process.env.SERVER;
  }
  if (process.env.SESSION_SECRET) {
    options.SESSION_SECRET = process.env.SESSION_SECRET;
  }
  if (process.env.SHORTNAME_PREFIX) {
    options.shortNamePrefix = process.env.SHORTNAME_PREFIX;
  }
  if (process.env.MONGODB_URL) {
    options.mongodbUrl = process.env.MONGODB_URL;
  }
  if (process.env.DASHBOARD_HOSTNAME) {
    options.dashboardHostname = process.env.DASHBOARD_HOSTNAME;
  }
  if (process.env.ENV) {
    options.env = process.env.ENV;
  }

  self.mongodbUrl = options.mongodbUrl;

  // All sites running under this process share a mongodb connection object
  const db = await mongo.MongoClient.connect(options.mongodbUrl, {
    useUnifiedTopology: true
  });

  // required on behalf of the application, so it can see the peer dependency
  const apostrophe = require(getNpmPath(options.root, 'apostrophe'));
  const express = require('express');
  const app = express();

  // Hostname of the dashbord site
  if (!options.dashboardHostname) {
    throw new Error('You must specify the options.dashboardHostname option or the DASHBOARD_HOSTNAME environment variable. The option may be an array, and the environment variable may be space-separated.');
  }
  if ((typeof options.dashboardHostname) === 'string') {
    if (options.dashboardHostname.match(/\s+/)) {
      options.dashboardHostname = options.dashboardHostname.split(',');
    }
    if (!Array.isArray(options.dashboardHostname)) {
      options.dashboardHostname = [ options.dashboardHostname ];
    }
  }
  if (!options.sessionSecret) {
    throw new Error('You must configure the sessionSecret option or set the SESSION_SECRET environment variable.');
  }

  let dashboard;

  if (argv.site) {
    return runTask();
  }

  if (argv['temporary-site']) {
    return runTaskOnTemporarySite();
  }

  if (argv['all-sites'] || argv.sites) {
    // --without-forking option runs the task without a separate child process
    // for each site, avoiding overhead but also compatible only with tasks
    // that end politely without exiting the process on their own
    return runTaskOnAllSites({
      withoutForking: argv['without-forking'],
      concurrency: argv.concurrency ? parseInt(argv.concurrency) : 1,
      someSites: argv.sites ? argv.sites.split(/,/) : false
    });
  }

  if (argv._[0] === 'tasks') {
    await runScheduledTasksOnAllSites();
    exit(0);
  }

  if (argv._.length) {
    throw new Error('To run a command line task you must specify --all-sites, --sites=name1,name2,name3, --temporary-site, or --site=hostname-or-id. To run a task for the dashboard site specify --site=dashboard');
  }

  self.dashboard = await spinUpDashboard();

  if (options.maxRequestsBeforeShutdown) {
    app.use(maxRequestsBeforeShutdownMiddleware);
    if (options.additionalRequestsBeforeShutdown === undefined) {
      options.additionalRequestsBeforeShutdown = 1000;
    }
    additionalRequestsBeforeShutdown = Math.round(Math.random() * options.additionalRequestsBeforeShutdown);
  }

  app.use(simpleUrlMiddleware);

  app.use(dashboardMiddleware);

  app.use(sitesMiddleware);

  if (process.env.PORT) {
    options.port = parseInt(process.env.PORT);
  }

  janitor();

  let server;

  if (options.server) {
    // Legacy
    const parts = options.server.split(':');
    if ((!parts) || (parts < 2)) {
      throw new Error('server option or SERVER environment variable is badly formed, must be address:port');
    }
    console.log('Proxy listening on port ' + parts[1]); // eslint-disable-line no-console
    server = app.listen(parts[1]);
  } else {
    console.log('Proxy listening on port ' + options.port); // eslint-disable-line no-console
    server = app.listen(options.port);
  }

  // keepalive timeout should be longer than that of nginx or
  // AWS ELB to avoid nasty race conditions resulting in
  // a low but frustrating percentage of failed requests. The
  // default keepalive timeout of nodejs is 5 seconds, which
  // isn't right for anybody using this module:
  //
  // https://shuheikagawa.com/blog/2019/04/25/keep-alive-timeout/

  server.keepAliveTimeout = options.keepAliveTimeout || (100 * 1000);

  await util.promisify(waitForServer)();

  function waitForServer(callback) {
    server.on('listening', function() {
      return callback(null);
    });
    server.on('error', function(e) {
      return callback(e);
    });
  }

  self.server = server;

  return self;

  function maxRequestsBeforeShutdownMiddleware(req, res, next) {
    req.on('end', async function() {
      requests++;
      if (requests === (options.maxRequestsBeforeShutdown + additionalRequestsBeforeShutdown)) {
        const httpTerminator = createHttpTerminator({
          server
        });
        await httpTerminator.terminate();
        exit(0);
      }
    });
    return next();
  }

  function dashboardMiddleware(req, res, next) {
    let site = req.get('Host');
    if (!site) {
      return next();
    }
    const matches = site.match(/^([^:]+)/);
    if (!matches) {
      return next();
    }
    site = matches[1].toLowerCase();
    if (!_.includes(options.dashboardHostname, site)) {
      return next();
    }
    return dashboard.app(req, res);
  }

  async function sitesMiddleware(req, res, next) {
    let hostname;
    let site;
    try {
      const host = req.get('Host');
      const matches = (host || '').match(/^([^:]+)/);
      if (!matches) {
        return next();
      }
      hostname = matches[1].toLowerCase();
      site = await getLiveSiteByHostname(hostname);
      if (!site) {
        return options.orphan(req, res);
      }
      if (site.redirect) {
        if (site.redirectPreservePath) {
          return res.redirect(parseInt(site.redirectStatus), site.redirectUrl + req.url);
        } else {
          return res.redirect(parseInt(site.redirectStatus), site.redirectUrl);
        }
      }
      if ((options.env === 'prod') && site.canonicalize && site.prodHostname) {
        if (hostname !== site.prodHostname.toLowerCase()) {
          return res.redirect(parseInt(site.canonicalizeStatus), `${req.protocol}://${site.prodHostname}${req.url}`);
        }
      }
      const apos = await self.getSiteApos(site);
      apos.app(req, res);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`Error in sitesMiddleware for ${req.url}, hostname: ${hostname}, found: ${!!site}, error:`, e);
      return res.status(500).send('error');
    }
  }

  function simpleUrlMiddleware(req, res, next) {
    // In development, using a .pac file is a convenient way to
    // direct all traffic for .multi test hostnames through
    // localhost:3000. However, this makes `req.url` an absolute
    // URL, which Apostrophe does not expect. Remove the host

    const matches = req.url.match(/^\w+:\/\/[^/]*(\/.*)$/);
    if (matches) {
      req.url = matches[1];
    }
    return next();
  }

  async function getLiveSiteByHostname(name) {
    return dashboard.docs.db.findOne({
      type: 'site',
      hostnames: { $in: [ name ] },
      // For speed and because they can have their own users and permissions
      // at page level, which works just fine, we do not implement the entire
      // Apostrophe permissions stack with regard to the site object before
      // deciding whether to proxy to it.
      //
      // However, we do make sure the site is published and not in the trash,
      // to keep things intuitive for the superadmin.
      trash: { $ne: true },
      published: true
    });
  }

  function log(site, level, msg) {
    if (msg != null) {
      msg = msg.toString();
    } else {
      msg = '';
    }
    const name = site.shortName || (site.hostnames && site.hostnames[0]) || site.slug || site._id;
    const defaultLogLevels = (process.env.NODE_ENV === 'production') ? 'warn,error' : 'info,debug,warn,error';
    const logLevels = (process.env.LOG_LEVEL || (process.env.VERBOSE ? 'info,debug,warn,error' : defaultLogLevels)).split(/,\s*/);
    if (logLevels.includes(level)) {
      if ((level === 'warn') || (level === 'error')) {
        if (argv.site) {
          console.error(msg); // eslint-disable-line no-console
        } else {
          // Trim the message because added blank lines do not read well
          // in the presence of the site name prefix
          console.error(name + ': ' + msg.trim()); // eslint-disable-line no-console
        }
      } else {
        if (argv.site) {
          console.log(msg); // eslint-disable-line no-console
        } else {
          // Trim the message because added blank lines do not read well
          // in the presence of the site name prefix
          console.log(name + ': ' + msg.trim()); // eslint-disable-line no-console
        }
      }
    }
  }

  // If present, `_options` is merged with the options object
  // passed to initialize Apostrophe. This argument is typically
  // used to prevent `argv` from being reused.

  async function spinUp(site, _options) {

    log(site, 'info', 'Spinning up...');
    aposes[site._id] = 'pending';

    const runner = Promise.promisify(run);
    let siteOptions;
    if ((typeof options.sites) === 'function') {
      siteOptions = options.sites(site);
    } else {
      siteOptions = options.sites || {};
    }
    siteOptions = _.merge({}, siteOptions, _options);

    return runner(siteOptions);

    function run(config, callback) {

      let viewsFolderFallback = getRootDir() + '/sites/views';
      if (!fs.existsSync(viewsFolderFallback)) {
        viewsFolderFallback = undefined;
      }

      // for bc don't require baseUrl to be set but it is
      // helpful for API implementations
      let baseUrl;

      if (options.env && site[options.env + 'BaseUrl']) {
        baseUrl = site[options.env + 'BaseUrl'];
      }

      const apos = apostrophe(

        _.merge({

          afterListen: function() {
            return callback(null, apos);
          },

          multisite: self,

          baseUrl: baseUrl,

          rootDir: getRootDir() + '/sites',

          npmRootDir: getRootDir(),

          shortName: options.shortNamePrefix + site._id,

          initFailed: function(err) {
            return apos.destroy(function(_err) {
              return callback(_err || err);
            });
          },

          modules: {

            'capture-id': {
              construct: function(self, options) {
                // Capture the site id early enough that tasks can see it
                apos._id = site._id;
              }
            },

            'apostrophe-db': {
              db: db
            },

            'apostrophe-i18n': {
              localesDir: getRootDir() + '/locales'
            },

            'apostrophe-templates': {
              viewsFolderFallback: viewsFolderFallback
            },

            'apostrophe-utils': {
              logger: function(apos) {
                return {
                  info: function(format, ...args) {
                    return log(site, 'info', util.format(format, ...args));
                  },
                  debug: function(format, ...args) {
                    return log(site, 'debug', util.format(format, ...args));
                  },
                  warn: function(format, ...args) {
                    return log(site, 'warn', util.format(format, ...args));
                  },
                  error: function(format, ...args) {
                    return log(site, 'error', util.format(format, ...args));
                  }
                };
              }
            },

            'apostrophe-express': {
              session: {
                secret: options.sessionSecret
              }
            },

            'apostrophe-attachments': {
              uploadfs: {
                prefix: '/' + site._id,
                uploadsPath: getRootDir() + '/sites/public/uploads',
                uploadsUrl: '/uploads',
                tempPath: getRootDir() + '/sites/data/temp/' + site._id + '/uploadfs',
                https: true,
                ...(process.env.CDN
                  ? {
                    cdn: {
                      enabled: true,
                      url: process.env.CDN + '/' + site._id
                    }
                  }
                  : {})
              }
            },

            'apostrophe-multisite-fake-listener': {
              construct: function(self, options) {
                // Don't really listen for connections. We'll run as middleware
                self.apos.listen = function() {
                  if (self.apos.options.afterListen) {
                    return self.apos.options.afterListen(null);
                  }
                };
              }
            },

            'apostrophe-multisite-patch-assets': {
              construct: function(self, options) {

                if (self.apos.assets.options.disabled) {
                  self.apos.assets.afterInit = function(callback) {
                    return setImmediate(callback);
                  };
                  self.apos.assets.determineGenerationAndExtract = function() {};
                }

                // The sites should share a collection for this purpose,
                // so they don't fail to see that a bundle has already been
                // generated via a temporary site during deployment
                self.apos.assets.generationCollection = dashboard.db.collection('sitesAssetGeneration');
                // Use a separate uploadfs instance for assets, so that the
                // sites share assets but not attachments

                self.apos.assets.uploadfs = function() {
                  return self.uploadfs;
                };

                self.initUploadfs = function(callback) {
                  self.uploadfs = require('uploadfs')();
                  const uploadfsDefaultSettings = {
                    backend: 'local',
                    prefix: '/shared-assets',
                    uploadsPath: getRootDir() + '/sites/public/uploads',
                    uploadsUrl: '/uploads',
                    tempPath: getRootDir() + '/sites/data/temp/shared-assets/uploadfs',
                    ...(process.env.CDN
                      ? {
                        cdn: {
                          enabled: true,
                          // uploadfs does not apply the prefix to the CDN unless told to
                          url: process.env.CDN + '/shared-assets'
                        }
                      }
                      : {})
                  };

                  self.uploadfsSettings = {};
                  _.merge(self.uploadfsSettings, uploadfsDefaultSettings);
                  _.merge(self.uploadfsSettings, options.uploadfs || {});

                  if (process.env.APOS_S3_BUCKET) {
                    _.merge(self.uploadfsSettings, {
                      backend: 's3',
                      endpoint: process.env.APOS_S3_ENDPOINT,
                      secret: process.env.APOS_S3_SECRET,
                      key: process.env.APOS_S3_KEY,
                      bucket: process.env.APOS_S3_BUCKET,
                      region: process.env.APOS_S3_REGION,
                      https: true
                    });
                  }

                  safeMkdirp(self.uploadfsSettings.uploadsPath);
                  safeMkdirp(self.uploadfsSettings.tempPath);
                  self.uploadfs = uploadfs();
                  self.uploadfs.init(self.uploadfsSettings, callback);
                  function safeMkdirp(path) {
                    try {
                      mkdirp.sync(path);
                    } catch (e) {
                      if (require('fs').existsSync(path)) {
                        // race condition in mkdirp but all is well
                      } else {
                        throw e;
                      }
                    }
                  }
                };

                // For dev: at least one site has already started up, which
                // means assets have already been attended to. Steal its
                // asset generation identifier so they don't fight.
                // We're not too late because apostrophe-assets doesn't
                // use this information until afterInit
                const superDetermineDevGeneration = self.apos.assets.determineDevGeneration;
                self.apos.assets.determineDevGeneration = function() {
                  const original = superDetermineDevGeneration();
                  const sample = getSampleSite();
                  if (!sample) {
                    return original;
                  }
                  return sample.assets.generation;
                };

                self.on('apostrophe:destroy', 'cleanUpUploadfs', function() {
                  return Promise.promisify(self.uploadfs.destroy)();
                });
              },

              afterConstruct: function(self, callback) {
                return self.initUploadfs(callback);
              }
            }
          }
        }, config)
      );
    }
  }

  // Return a sample site that is already spun up, if there are any.
  // Useful for reusing resources that would otherwise be
  // redundantly generated at startup

  function getSampleSite() {
    const keys = _.keys(aposes);
    if (!keys.length) {
      return null;
    }
    // Find the first one that isn't a status string like "pending"
    return _.find(aposes, apos => (typeof apos) === 'object');
  }

  // config object is optional and is merged last with the options
  // passed to apostrophe for the dashboard site

  async function spinUpDashboard(config) {

    log({ _id: 'dashboard' }, 'info', 'Spinning up dashboard site...');

    // TODO: this function has a lot of code in common with spinUp.
    // Think about that. Should we support multiple constellations of
    // sites in a single process, and just make the dashboard a specialized
    // constellation at some point?

    const finalConfig = _.merge({}, options.dashboard || {}, config);

    const apos = await util.promisify(run)(finalConfig);

    return apos;

    function run(config, callback) {

      let viewsFolderFallback = getRootDir() + '/dashboard/views';
      if (!fs.existsSync(viewsFolderFallback)) {
        viewsFolderFallback = undefined;
      }

      let baseUrl = 'baseUrl-not-set';

      if (options.env && config[options.env + 'BaseUrl']) {
        baseUrl = config[options.env + 'BaseUrl'];
      }

      const apos = apostrophe(

        _.merge({

          multisite: self,

          baseUrl: baseUrl,

          afterListen: function(err) {
            if (err) {
              // It's chill, try again until we get a free port.
              return apos.destroy(function() {
                return run(config, callback);
              });
            }
            apos._id = 'dashboard';
            return callback(null, apos);
          },

          rootDir: getRootDir() + '/dashboard',

          npmRootDir: getRootDir(),

          shortName: options.shortNamePrefix + 'dashboard',

          modules: {

            'apostrophe-assets': {
              construct: function(self, options) {
                // Make it possible to disable the asset build so it doesn't
                // take up time and change the asset generation if we're just
                // running a task for another site, a situation in which we
                // only need the dashboard in order to access the db containing
                // that site
                if (options.disabled) {
                  self.afterInit = function() {};
                  self.determineGenerationAndExtract = function() {};
                }
              }
            },

            'apostrophe-i18n': {
              localesDir: getRootDir() + '/locales'
            },

            'apostrophe-db': {
              db: db
            },

            'apostrophe-templates': {
              viewsFolderFallback: viewsFolderFallback
            },

            'apostrophe-express': {
              session: {
                secret: options.sessionSecret
              }
            },

            'apostrophe-attachments': {
              uploadfs: {
                prefix: '/dashboard',
                uploadsPath: getRootDir() + '/dashboard/public/uploads',
                uploadsUrl: '/uploads',
                tempPath: getRootDir() + '/data/temp/dashboard/uploadfs',
                // Avoid mixed content warning
                https: true,
                ...(process.env.CDN
                  ? {
                    cdn: {
                      enabled: true,
                      url: process.env.CDN + '/dashboard'
                    }
                  }
                  : {})
              }
            },

            'apostrophe-multisite-fake-listener': {
              construct: function(self, options) {
                // Don't really listen for connections. We'll run as middleware
                self.apos.listen = function() {
                  if (self.apos.options.afterListen) {
                    return self.apos.options.afterListen(null);
                  }
                };
              }
            },

            // a base class for the sites module allows the dev
            // to extend it easily project-level as if it were
            // coming from an npm module. -Tom
            'sites-base': require('./lib/sites-base.js'),

            'apostrophe-utils': {
              logger: function(apos) {
                const site = { _id: 'dashboard' };
                return {
                  info: function(format, ...args) {
                    return log(site, 'info', util.format(format, ...args));
                  },
                  debug: function(format, ...args) {
                    return log(site, 'debug', util.format(format, ...args));
                  },
                  warn: function(format, ...args) {
                    return log(site, 'warn', util.format(format, ...args));
                  },
                  error: function(format, ...args) {
                    return log(site, 'error', util.format(format, ...args));
                  }
                };
              }
            },

            sites: {
              extend: 'sites-base',
              alias: 'sites'
            }

          }
        }, config)
      );

      // We need access to this early, so the dashboard can
      // spin up instances of sites in the cleanup task, etc.
      dashboard = apos;
    }
  }

  async function runTask() {
    // Running an apostrophe task for a specific site
    if (argv.site === 'dashboard') {
      await spinUpDashboard();
      return 'task';
      // Task will execute, and will exit process on completion
    }
    // Prevent dashboard from attempting to run the task when it wakes up,
    // also prevent it from causing problems for another instance in dev
    // that has already built dashboard assets. All we want from it is access
    // to the database of other sites
    dashboard = await spinUpDashboard(
      {
        argv: { _: [] },
        modules: {
          'apostrophe-assets': {
            disabled: true
          }
        }
      }
    );
    let site;
    site = argv.site.toLowerCase();
    site = await dashboard.docs.db.findOne({
      type: 'site',
      $or: [
        {
          hostnames: { $in: [ site ] }
        },
        {
          _id: site
        }
      ],
      trash: { $ne: true }
      // unpublished is OK, for prep purposes
    });
    if (!site) {
      throw new Error('There is no such site.');
    }
    await spinUp(site);
    // Task will execute, and will exit process on completion
    return 'task';
  }

  async function runTaskOnTemporarySite() {
    return runTaskOnAllSites({ temporary: true });
  }

  async function runScheduledTasksOnAllSites() {
    if (!options.tasks) {
      return;
    }
    const frequency = argv.frequency;
    if (!frequency) {
      throw new Error('--frequency must be hourly or daily.');
    }
    if (options.tasks['all-sites']) {
      const tasks = options.tasks['all-sites'][frequency] || [];
      const guard = {
        hourly: 50,
        daily: 23 * 60
      };
      for (const task of (tasks || [])) {
        await runScheduledTaskOnAllSites(
          task,
          guard[frequency]
        );
      }
    }
    if (options.tasks.dashboard) {
      const tasks = options.tasks.dashboard[frequency] || [];
      const guard = {
        hourly: 50,
        daily: 23 * 60
      };
      for (const task of (tasks || [])) {
        await runScheduledTaskOnDashboard(
          task,
          guard
        );
      }
    }
  }

  async function runTaskOnAllSites(options) {
    options = options || {};
    // Prevent dashboard from attempting to run the task or touch assets
    // when it wakes up
    dashboard = await spinUpDashboard({
      argv: { _: [] },
      modules: {
        'apostrophe-assets': {
          disabled: true
        }
      }
    });
    const req = dashboard.tasks.getReq();
    let sites;
    if (options.temporary) {
      const site = {
        title: '** Temporary for Command Line Task',
        published: false,
        trash: false,
        _id: dashboard.utils.generateId()
      };
      if (argv.theme) {
        site.theme = argv.theme;
      }
      await dashboard.sites.insert(req, site);
      sites = [ site ];
    } else if (options.someSites) {
      const identifiers = options.someSites;
      sites = await dashboard.sites.find(req, {
        $or: [
          {
            hostnames: {
              $in: identifiers
            }
          },
          {
            _id: {
              $in: identifiers
            }
          }
        ]
      }).toArray();
    } else {
      sites = await dashboard.sites.find(req, {}).toArray();
    }
    if (options.withoutForking) {
      if (sites.length > 10) {
        // fork anyway but run in groups of 10
        // Avoid running out of memory in Linux, node does not seem to return
        // the resources promptly enough
        const spawn = require('child_process').spawnSync;
        for (let i = 0; (i < sites.length); i += 10) {
          const ids = sites.slice(i, i + 10).map(site => site._id);
          const result = spawn(process.argv[0], process.argv.slice(1).concat([ '--sites=' + ids.join(',') ]), {
            encoding: 'utf8',
            stdio: 'inherit'
          });
          if (result.status !== 0) {
            throw new Error(result.status || ('exited on signal ' + result.signal));
          }
        }
      } else {
        await Promise.map(sites, runOne, { concurrency: options.concurrency || 1 });
      }
    } else {
      const spawn = require('child_process').spawnSync;
      sites.forEach(site => {
        log(site, 'info', `running task ${argv._[0]}`);
        const result = spawn(process.argv[0], process.argv.slice(1).concat([ '--site=' + site._id ]), {
          encoding: 'utf8',
          stdio: 'inherit'
        });
        if (result.status !== 0) {
          throw new Error(result.status || ('exited on signal ' + result.signal));
        }
      });
    }
    if (options.temporary) {
      await db.db(multisiteOptions.shortNamePrefix + sites[0]._id).dropDatabase();
      await dashboard.docs.db.remove({ _id: sites[0]._id });
    }
    // Our job to exit since we know the tasks are all complete already
    exit(0);

    async function runOne(site) {
      log(site, 'info', `running task ${argv._[0]}`);
      const apos = await self.getSiteApos(site, {
        argv: {
          _: []
        },
        modules: {
          ...((argv._[0] === 'apostrophe:generation') ? {} : {
            'apostrophe-assets': {
              disabled: true
            }
          })
        }
      });
      await apos.tasks.invoke(argv._[0], argv._.slice(1), argv);
      await Promise.promisify(apos.destroy)();
    }
  }

  // Run the named task, with no extra arguments, on all sites,
  // locking against simultaneous runs and returning immediately
  // if it has been started fewer than `guard` minutes ago

  async function runScheduledTaskOnAllSites(task, guard) {
    // Prevent dashboard from attempting to run the task or touch assets
    // when it wakes up
    dashboard = await spinUpDashboard({
      argv: { _: [] },
      modules: {
        'apostrophe-assets': {
          disabled: true
        }
      }
    });
    let locked = false;
    const taskLog = dashboard.db.collection('aposTaskLog');
    await taskLog.createIndex({
      task: 1,
      startedAt: -1
    });
    try {
      await dashboard.locks.lock(`all-${task}`);
      locked = true;
      const safe = new Date();
      safe.setMinutes(safe.getMinutes() - guard);
      const last = await taskLog.findOne({
        task: `all-${task}`,
        startedAt: {
          $gte: safe
        }
      });
      if (last) {
        return;
      }

      await taskLog.insert({
        task: `all-${task}`,
        startedAt: new Date()
      });

      const req = dashboard.tasks.getReq();
      const sites = await dashboard.sites.find(req, {}).toArray();
      for (const site of sites) {
        log(site, 'info', 'running ' + task);
        const args = process.argv.slice(1);
        args[args.findIndex(arg => arg === 'tasks')] = task;
        args.push('--site=' + site._id);
        await util.promisify(spawn)(process.argv[0], args, {
          encoding: 'utf8',
          stdio: 'inherit'
        });
      }
    } finally {
      if (locked) {
        await dashboard.locks.unlock(`all-${task}`);
      }
    }
    function spawn(program, args, options, callback) {
      return require('child_process').spawn(program, args, options).on('close', function(code) {
        if (!code) {
          return callback(null);
        }
        return callback(code);
      });
    }
  }

  // Run the named task, with no extra arguments, on the dashboard site,
  // locking against simultaneous runs and returning immediately
  // if it has been started fewer than `guard` minutes ago

  async function runScheduledTaskOnDashboard(task, guard) {
    // Prevent dashboard from attempting to run the task or touch assets
    // when it wakes up
    dashboard = await spinUpDashboard({
      argv: { _: [] },
      modules: {
        'apostrophe-assets': {
          disabled: true
        }
      }
    });
    let locked = false;
    const taskLog = dashboard.db.collection('aposTaskLog');
    await taskLog.createIndex({
      task: 1,
      startedAt: -1
    });
    try {
      await dashboard.locks.lock(`dashboard-${task}`);
      locked = true;
      const safe = new Date();
      safe.setMinutes(safe.getMinutes() - guard);
      const last = await taskLog.findOne({
        task: `dashboard-${task}`,
        startedAt: {
          $gte: safe
        }
      });
      if (last) {
        return;
      }

      await taskLog.insert({
        task: `dashboard-${task}`,
        startedAt: new Date()
      });

      const args = process.argv.slice(1);
      args[args.findIndex(arg => arg === 'tasks')] = task;
      args.push('--site=dashboard');
      await util.promisify(spawn)(process.argv[0], args, {
        encoding: 'utf8',
        stdio: 'inherit'
      });
    } finally {
      if (locked) {
        await dashboard.locks.unlock(`dashboard-${task}`);
      }
    }
    function spawn(program, args, options, callback) {
      return require('child_process').spawn(program, args, options).on('close', function(code) {
        if (!code) {
          return callback(null);
        }
        return callback(code);
      });
    }
  }

  function getRoot() {
    let _module = module;
    let m = _module;
    while (m.parent) {
      // The test file is the root as far as we are concerned,
      // not mocha itself
      if (m.parent.filename.match(/\/node_modules\/mocha\//)) {
        return m;
      }
      m = m.parent;
      _module = m;
    }
    return _module;
  }

  function getRootDir() {
    const path = require('path');
    return path.dirname(path.resolve(getRoot().filename));
  }

  function getNpmPath(root, type) {
    const npmResolve = require('resolve');
    return npmResolve.sync(type, { basedir: getRootDir() });
  }

  // Periodically free apos objects allocated to serve sites that
  // are no longer visible or no longer exist

  function janitor() {
    self.janitorInterval = setInterval(sweep, 60000);
    async function sweep() {
      const ids = Object.keys(aposes);
      if (!ids.length) {
        return;
      }
      let sites = await dashboard.docs.db.find({
        type: 'site',
        _id: { $in: ids },
        trash: { $ne: true },
        published: true
      }, {
        _id: 1
      }).toArray();
      sites = sites.map(site => site._id);
      const missing = _.difference(ids, sites);
      missing.forEach(id => {
        const apos = aposes[id];
        if ((typeof apos) !== 'object') {
          return;
        }
        apos.destroy(function() {});
        delete aposes[id];
      });
    }
  }

};
