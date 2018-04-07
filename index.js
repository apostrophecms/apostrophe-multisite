const _ = require('lodash');
const mongo = require('mongodb');
const fs = require('fs');
const argv = require('boring')();
const quote = require('shell-quote').quote;
const Promise = require('bluebird');

module.exports = async function(options) {

  let local = {};
  let lockDepth = 0;
  if (fs.existsSync(getRootDir() + '/data/local.js')) {
    local = require(getRootDir() + '/data/local.js');
  }
  _.defaultsDeep(local, options, {
    // At least 2 = failover during forever restarts etc.,
    // also resiliency against server failures if more than
    // one server is provided
    concurrencyPerSite: 2,
    // Space-separated list of all servers being load balanced
    // by nginx, including multiple instances on the same physical server
    // listening on different ports. Like:
    //
    // 10.1.1.10:3000 10.1.1.10:3001 10.1.1.11:3000 10.1.1.11:3001 ...
    //
    // Default assumption is you have just one on localhost (which is a bad idea,
    // you should run more, ideally across physical servers).
    servers: [ 'localhost:3000' ],
    // THIS server, in the same format as above, so it can distinguish
    // itself from the rest
    server: 'localhost:3000',
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

  if (process.env.CONCURRENCY_PER_SITE) {
    options.concurrencyPerSite = parseInt(process.env.CONCURRENCY_PER_SITE);
  }
  if (options.concurrencyPerSite > options.servers.length) {
    console.warn('Capping concurrency at the number of server processes: ' + options.servers.length);
    options.concurrencyPerSite = options.servers.length;
  }

  if (process.env.SERVERS) {
    options.servers = process.env.SERVERS.split(',');
  }
  if (process.env.SERVER) {
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
  
  // All sites running under this process share a mongodb connection object
  const db = await mongo.MongoClient.connect(options.mongodbUrl, {
    autoReconnect: true,
    // retry forever
    reconnectTries: Number.MAX_VALUE,
    reconnectInterval: 1000
  });

  // required on behalf of the application, so it can see the peer dependency
  const apostrophe = require(getNpmPath(options.root, 'apostrophe'));
  const express = require('express');
  const app = express();

  // apos app objects by site _id
  const apps = {};

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
  const lowPort = parseInt(process.env.LOW_PORT || '4000');
  const totalPorts = parseInt(process.env.TOTAL_PORTS || '50000');

  let dashboard;

  if (argv.site) {
    return runTask();
  }

  if (argv['temporary-site']) {
    return runTaskOnTemporarySite();
  }

  if (argv['all-sites']) {
    return runTaskOnAllSites();
  }

  if (argv._.length) {
    throw new Error('To run a command line task you must specify --all-sites, --temporary-site, or --site=hostname-or-id. To run a task for the dashboard site specify --site=dashboard');
  }

  dashboard = await spinUpDashboard();

  app.use(dashboardMiddleware);

  app.use(sitesMiddleware);

  const listen = require('util').promisify(app.listen.bind(app));

  const parts = options.server.split(':');
  if ((!parts) || (parts < 2)) {
    throw new Error('server option or SERVER environment variable is badly formed, must be address:port');
  }

  console.log('Proxy listening on port ' + parts[1]);
  return await listen(parts[1]);

  function dashboardMiddleware(req, res, next) {
    return dashboard.app(req, res);
  }

  async function sitesMiddleware(req, res, next) {
    console.log(req.get('Host') + ':' + req.url);
    const sites = dashboard.modules && dashboard.modules.sites;
    let site = req.get('Host');
    const matches = (site || '').match(/^([^\:]+)/);
    if (!matches) {
      return next();
    }
    site = matches[1].toLowerCase();

    site = await getLiveSiteByHostname(site);
    if (!site) {
      return options.orphan(req, res);
    }
    log(site, 'matches request');
    let winner;
    if (!apps[site._id]) {
      apps[site._id] = await spinUp(site);
    }
    return apps[site._id](req, res);
  }

  async function getLiveSiteByHostname(name) {
    return await dashboard.docs.db.findOne({
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

  function log(site, msg) {
    const name = (site.hostnames && site.hostnames[0]) || site._id;
    console.log(name + ': ' + msg);
  }

  async function spinUpHere(site) {

    log(site, 'Asked to spin up here...');

    if (listening[site._id] && (listening[site._id] !== 'pending')) {
      log(site, 'Already here...');
      // Race condition got us here but we already are listening. Repair
      // any discrepancy between the database and what we know about ourselves
      if (!site.listeners[options.server]) {
        site.listeners[options.server] = hostnameOnly(options.server) + ':' + listening[site._id];
        const $set = {};
        $set['listeners.' + options.server] = site.listeners[options.server];
        await dashboard.docs.db.update({
          _id: site._id
        }, {
          $set: $set
        });
      }
      return await getLiveSiteByHostname(site.hostnames[0]);
    }

    if (listening[site._id] === 'pending') {
      // We will be listening soon
      await Promise.delay(100);
      log(site, 'Still pending here...');
      site = await getLiveSiteByHostname(site.hostnames[0]);
      return await spinUpHere(site);
    }

    listening[site._id] = 'pending';

    log(site, 'Spinning up here...');

    // The available free-port-finder modules all have race conditions and
    // no provision for avoiding popular ports like 3000. Pick randomly and
    // retry if necessary.

    let port;
    let apos;

    port = Math.floor(lowPort + Math.random() * totalPorts);
    apos = await require('util').promisify(run)(options.sites || {});

    site.listeners[options.server] = hostnameOnly(options.server) + ':' + port;
    const $set = {};
    $set['listeners.' + options.server] = site.listeners[options.server];
    await dashboard.docs.db.update({
      _id: site._id
    }, {
      $set: $set
    });
    listening[site._id] = port;
    return site;
    
    function run(config, callback) {

      let viewsFolderFallback = getRootDir() + '/sites/views';
      if (!fs.existsSync(viewsFolderFallback)) {
        viewsFolderFallback = undefined;
      }

      const apos = apostrophe(

        _.merge({

          afterListen: function(err) {
            if (err) {
              // It's chill, try again until we get a free port.
              return apos.destroy(function() {
                return run(config, callback);
              });
            }
            apos._id = site._id;
            return callback(null, apos);
          },

          rootDir: getRootDir() + '/sites', 

          npmRootDir: getRootDir(),
               
          shortName: options.shortNamePrefix + site._id,
          
          modules: {

            'apostrophe-db': {
              db: db
            },
            
            'apostrophe-i18n': {
              localesDir: getRootDir() + '/locales'
            },

            'apostrophe-templates': {
              viewsFolderFallback: viewsFolderFallback
            },

            'apostrophe-express': {
              session: {
                secret: options.sessionSecret
              },
              forcePort: port
            },
            
            'apostrophe-attachments': {
              // TODO consider S3 in this context
              uploadfs: {
                uploadsPath: getRootDir() + '/sites/public/uploads/' + site._id,
                uploadsUrl: '/uploads/' + site._id,
                tempPath: __dirname + '/data/temp/' + site._id + '/uploadfs'
              }
            }
          }
        }, config)
      );
    }
  }

  // config object is optional and is merged last with the options
  // passed to apostrophe for the dashboard site

  async function spinUpDashboard(config) {

    console.log('Spinning up dashboard site...');

    // TODO: this function has a lot of code in common with spinUpHere.
    // Think about that. Should we support multiple constellations of
    // sites in a single process, and just make the dashboard a specialized
    // constellation at some point?

    // The available free-port-finder modules all have race conditions and
    // no provision for avoiding popular ports like 3000. Pick randomly and
    // retry if necessary. -Tom

    const port = Math.floor(lowPort + Math.random() * totalPorts);

    const finalConfig = _.merge({}, options.dashboard || {}, config);
    const apos = await require('util').promisify(run)(finalConfig);
    
    return apos;
    
    function run(config, callback) {

      let viewsFolderFallback = getRootDir() + '/dashboard/views';
      if (!fs.existsSync(viewsFolderFallback)) {
        viewsFolderFallback = undefined;
      }

      const apos = apostrophe(

        _.merge({

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
              },
              forcePort: port
            },
            
            'apostrophe-attachments': {
              // TODO consider S3 in this context
              uploadfs: {
                uploadsPath: getRootDir() + '/dashboard/public/uploads/dashboard',
                uploadsUrl: '/uploads/dashboard',
                tempPath: __dirname + '/data/temp/dashboard/uploadfs'
              }
            },

            // a base class for the sites module allows the dev
            // to extend it easily project-level as if it were
            // coming from an npm module. -Tom
            'sites-base': {
              instantiate: false,
              extend: 'apostrophe-pieces',
              name: 'site',
              beforeConstruct: function(self, options) {
                options.addFields = [
                  {
                    type: 'array',
                    name: 'hostnamesArray',
                    label: 'Hostnames',
                    schema: [
                      {
                        type: 'string',
                        required: true,
                        name: 'hostname',
                        help: 'All valid hostnames for the site must be on this list, for instance both example.com and www.example.com'
                      }
                    ]
                  }
                ].concat(options.addFields || []);
              },
              construct: function(self, options) {
                self.beforeSave = function(req, doc, options, callback) {
                  doc.hostnames = _.map(doc.hostnamesArray || [], function(value) {
                    return value.hostname.toLowerCase().trim();
                  });
                  doc.listeners = doc.listeners || {};
                  return callback(null);
                };
              }
            },

            'sites': {
              extend: 'sites-base',
              alias: 'sites'
            }

          }
        }, config)
      );
    }      
  }

  async function runTask() {
    // Running an apostrophe task for a specific site
    if (argv.site === 'dashboard') {
      await spinUpDashboard();
      return 'task';
      // Task will execute, and will exit process on completion
    }
    // Prevent dashboard from attempting to run the task when it wakes up
    dashboard = await spinUpDashboard({ argv: { _: [] } });
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
    await spinUpHere(site);
    // Task will execute, and will exit process on completion
    return 'task';
  }

  async function runTaskOnTemporarySite() {
    return runTaskOnAllSites({ temporary: true });
  }

  async function runTaskOnAllSites(options) {
    options = options || {};
    // Prevent dashboard from attempting to run the task when it wakes up
    dashboard = await spinUpDashboard({ argv: { _: [] } });
    const req = dashboard.tasks.getReq();
    let sites;
    if (options.temporary) {
      const site = {
        title: '** Temporary for Command Line Task',
        published: false,
        trash: false,
        _id: dashboard.utils.generateId()
      };
      await dashboard.sites.insert(req, site);
      sites = [ site ];
    } else {
      sites = await dashboard.sites.find(req, {}).toArray();
    }
    const spawn = require('child_process').spawnSync;
    sites.forEach(site => {
      log(site, 'running task');
      const result = spawn(process.argv[0], process.argv.slice(1).concat(['--site=' + site._id]), { encoding: 'utf8' });
      if (result.stdout.length) {
        console.log(result.stdout);
      }
      if (result.stderr.length) {
        console.error(result.stderr);
      }
    });
    if (options.temporary) {
      console.log('Cleaning up temporary site');
      await dashboard.docs.db.remove({ _id: sites[0]._id });
    }
    // Our job to exit since we know the tasks are all complete already
    process.exit(0);
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

  function hostnameOnly(server) {
    return server.replace(/\:\d+$/, '');
  }

  async function lock() {
    if (!lockDepth) {
      console.log('> locking...');
      await dashboard.locks.lock('multisite-spinup');
      console.log('locked');
    }
    lockDepth++;
  }

  async function unlock() {
    console.log('unlock invoked');
    lockDepth--;
    if (!lockDepth) {
      await dashboard.locks.unlock('multisite-spinup');
      console.log('< unlocked');
    }
  }

};

