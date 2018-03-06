const _ = require('lodash');
const mongo = require('mongodb');
const fs = require('fs');
const argv = require('boring')();
const quote = require('shell-quote').quote;

module.exports = async function(options) {

  _.defaults(options, {
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

  if (process.env.SERVERS) {
    options.servers = process.env.SERVERS.split(' ');
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
  const httpProxy = require('http-proxy');
  const express = require('express');
  const app = express();

  // Hostname of the dashbord site
  const dashboardHostname = options.dashboardHostname;
  if (!dashboardHostname) {
    throw new Error('You must specify the dashboardHostname option or the DASHBOARD_HOSTNAME environment variable.');
  }
  if (!options.sessionSecret) {
    throw new Error('You must configure the sessionSecret option or set the SESSION_SECRET environment variable.');
  }
  const lowPort = parseInt(process.env.LOW_PORT || '4000');
  const totalPorts = parseInt(process.env.TOTAL_PORTS || '50000');

  if (argv.site) {
    return runTask();
  }

  if (argv['all-sites']) {
    return runTaskOnAllSites();
  }

  if (argv._.length) {
    throw new Error('To run a command line task you must specify either --all-sites or --site=hostname-or-id. To run a task for the dashboard site specify --site=dashboard');
  }

  const dashboard = await spinUpDashboard();
  const proxy = httpProxy.createProxyServer({});

  app.use(dashboardMiddleware);

  app.use(proxyMiddleware);

  const listen = require('util').promisify(app.listen.bind(app));

  const parts = options.server.split(':');
  if ((!parts) || (parts < 2)) {
    throw new Error('server option or SERVER environment variable is badly formed, must be address:port');
  }

  console.log('Proxy listening on port ' + parts[1]);
  return await listen(parts[1]);

  async function dashboardMiddleware(req, res, next) {
    const attempt = require('util').promisify(proxy.web.bind(proxy));
    let site = req.get('Host');
    const matches = site.match(/^([^\:]+)/);
    if (!matches) {
      return next();
    }
    site = matches[1].toLowerCase();
    if (site !== options.dashboardHostname) {
      return next();
    }
    try {
      await attempt(req, res, { target: 'http://' + hostnameOnly(options.server) + ':' + dashboard.modules['apostrophe-express'].port });
    } catch (e) {
      // Currently a dashboard crash requires a restart of this process
      // (but you should have more than one process)
      console.error(e);
      process.exit(1);
    }
  }

  async function proxyMiddleware(req, res, next) {

    const sites = dashboard.modules && dashboard.modules.sites;
    let site = req.get('Host');
    const matches = (site || '').match(/^([^\:]+)/);
    if (!matches) {
      return next();
    }
    site = matches[1].toLowerCase();

    try {
      site = await dashboard.docs.db.findOne({
        type: 'site',
        hostnames: { $in: [ site ] },
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
      if (!site) {
        return options.orphan(req, res);
      }
      log(site, 'matches request');
      let winner;

      if (req.headers['x-apostrophe-multisite-spinup'] === options.apiKey) {
        log(site, 'we have been asked to spin it up');
        if (!site.listeners[options.server]) {
          log(site, 'it is new on this server');
          site = await spinUpHere(site);
          console.log(site);
        } else {
          log(site, 'it already exists on this server');
        }
        winner = options.server;
      } else {
        log(site, 'spinning up if needed');
        site = await spinUpAsNeeded(req, site);
      }

      let retried;
      do {
        retried = false;
        const keys = Object.keys(site.listeners);
        const winningServer = keys[Math.floor(Math.random() * keys.length)];
        winner = site.listeners[winningServer];
        const attempt = require('util').promisify(proxy.web.bind(proxy));
        try {
          log(site, 'proxying to ' + winner);
          await attempt(req, res, { target: 'http://' + winner });
          log(site, 'proxy request succeeded');
        } catch (e) {
          log(site, 'proxy request failed, marking as dead listener');
          retried = true;
          const $unset = {};
          $unset['listeners.' + winningServer] = 1;
          await dashboard.docs.db.update({
            _id: site._id
          }, {
            $unset: $unset
          });
          delete site.listeners[winningServer];
          site = await spinUpAsNeeded(req, site);
        }
      } while (retried);
    } catch (e) {
      console.error(e);
      return res.status(500).send('error');
    }
  }

  async function spinUpAsNeeded(req, site) {
    while (Object.keys(site.listeners).length < options.concurrencyPerSite) {
      site = await spinUp(req, site);
    }
    return site;
  }

  function log(site, msg) {
    const name = (site.hostnames && site.hostnames[0]) || site._id;
    console.log(name + ': ' + msg);
  }

  async function spinUp(req, site) {
    log(site, 'spinning up somewhere...');
    // Where should it be spun up?
    // Preference for a separate physical server
    const keys = Object.keys(site.listeners);
    let server = options.servers.find(server => {
      return !keys.find(listener => {
        return hostnameOnly(listener) === hostnameOnly(server);
      });
    });
    if (server) {
      log(site, 'remote server chosen: ' + server);
    }
    if (!server) {
      // Settle for a different core
      server = options.servers.find(server => {
        return !keys.find(listener => {
          return listener === server;
        });
      });
      log(site, 'local server chosen: ' + server);
    }
    if (!server) {
      // It is already spun up everywhere
      log(site, 'already spun up everywhere');
      return site;
    }
    if (server === options.server) {
      return spinUpHere(site);
    } else {
      return spinUpThere(req, site, server);
    }
  }

  async function spinUpThere(req, site, server) {
    log(site, 'Asking a peer to spin it up...');
    // Make it as if this header was always there. Less weird than
    // using the proxy events. -Tom
    req.headers['x-apostrophe-multisite-spinup'] = options.apiKey;
    req.rawHeaders.push('X-Apostrophe-Multisite-Spinup', options.apiKey);
    const attempt = require('util').promisify(proxy.web.bind(proxy));
    log(site, 'proxying to ' + server);
    return attempt(req, req.res, { target: 'http://' + server });
  }

  async function spinUpHere(site) {

    log(site, 'Spinning up here...');

    // The available free-port-finder modules all have race conditions and
    // no provision for avoiding popular ports like 3000. Pick randomly and
    // retry if necessary. -Tom

    const port = Math.floor(lowPort + Math.random() * totalPorts);

    const apos = await require('util').promisify(run)(options.sites || {});

    site.listeners[options.server] = hostnameOnly(options.server) + ':' + port;
    const $set = {};
    $set['listeners.' + options.server] = site.listeners[options.server];
    await dashboard.docs.db.update({
      _id: site._id
    }, {
      $set: $set
    });
    
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

          modulesSubdir: getRootDir() + '/sites/lib/modules', 
               
          shortName: options.shortNamePrefix + site._id,
          
          modules: {

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
                uploadsPath: __dirname + '/public/uploads/' + site._id,
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

          modulesSubdir: getRootDir() + '/dashboard/lib/modules', 
                
          shortName: options.shortNamePrefix + 'dashboard',
          
          modules: {

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
                uploadsPath: __dirname + '/public/uploads/dashboard',
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
    const dashboard = await spinUpDashboard({ argv: { _: [] } });
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

  async function runTaskOnAllSites() {
    // Prevent dashboard from attempting to run the task when it wakes up
    const dashboard = await spinUpDashboard({ argv: { _: [] } });
    var req = dashboard.tasks.getReq();
    const sites = await dashboard.sites.find(req, {}).toArray();
    const spawn = require('child_process').spawnSync;
    sites.forEach(site => {
      log(site, 'running task');
      spawn(process.argv[0], process.argv.slice(1).concat('--site=' + site._id));
    });
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
    var path = require('path');
    return path.dirname(path.resolve(getRoot().filename));
  }

  function getNpmPath(root, type) {
    const npmResolve = require('resolve');
    return npmResolve.sync(type, { basedir: getRootDir() });
  }

  function hostnameOnly(server) {
    return server.replace(/\:\d+$/, '');
  }

};

