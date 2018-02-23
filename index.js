const _ = require('lodash');
const mongo = require('mongodb');
const fs = require('fs');

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
    servers: (process.env.SERVERS && process.env.SERVERS.split(' ')) || [ 'localhost:3000' ],
    // THIS server, in the same format as above, so it can distinguish
    // itself from the rest
    server: process.env.SERVER || 'localhost:3000',
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
    shortNamePrefix: process.env.SHORTNAME_PREFIX || 'multisite-',
    // MongoDB URL for database connection. If you have multiple physical
    // servers then you MUST configure this to a SHARED server (which
    // may be a replica set)
    mongodbUrl: process.env.MONGODB_URL || 'mongodb://localhost:27017',
    dashboardHostname: process.env.DASHBOARD_HOSTNAME,
    root: getRoot()
  });
  
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
  const dashboardPort = await spinUpDashboard();
  const proxy = httpProxy.createProxyServer({});

  app.use(dashboardMiddleware);

  app.use(proxyMiddleware);

  const listen = require('util').promisify(app.listen.bind(app));

  const parts = options.server.split(':');
  if ((!parts) || (parts < 2)) {
    throw new Error('server option or SERVER environment variable is badly formed, must be address:port');
  }

  return await listen(parts[1], function(err) {
    if (err) {
      return callback(err);
    }
    console.log('Listening...');
    // Never invoke callback if listening
  });

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
      await attempt(req, res, { target: 'http://' + options.server + ':' + dashboardPort });
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
    const matches = site.match(/^([^\:]+)/);
    if (!matches) {
      return next();
    }
    site = matches[1].toLowerCase();
    if (site === dashboardHostname) {
      return next();
    }

    try {

      site = await dashboard.docs.db.findOne({
        type: 'site',
        hostnames: { $in: site }
      });

      let winner;

      if (req.headers['X-Apostrophe-Multisite-Spinup']) {
        if (!site.listeners[options.server]) {
          site = await spinUpHere(req, site);
        }
        winner = options.server;
      } else {
        site = await spinUpAsNeeded(req, site);
      }

      const keys = site.listeners.keys();
      const winner = site.listeners[keys][Math.floor(Math.random() * keys.length)];

      const attempt = require('util').promisify(proxy.web.bind(proxy));

      let retried;
      do {
        retried = false;
        try {
          attempt(req, res, { target: 'http://' + winner });
        } catch (e) {
          retried = true;
          const $unset = {};
          $unset[winner] = 1;
          await dashboard.docs.db.update({
            _id: site._id
          }, {
            $unset: $unset
          });
          site = await spinUpAsNeeded(site);
        }
      } while (retried);
    } catch (e) {
      console.error(e);
      return res.status(500).send('error');
    }
  }


  async function spinUpAsNeeded(req, site) {
    while (site.listeners.keys().length < options.concurrencyPerSite) {
      site = await spinUp(req, site);
    }
    return site;
  }

  async function spinUp(req, site) {
    // Where should it be spun up?
    // Preference for a separate physical server
    const keys = site.listeners.keys();
    let server = options.servers.find(server => {
      return !keys.find(listener => {
        return hostnameOnly(listener) === hostnameOnly(server);
      });
    });
    if (!server) {
      // Settle for a different core
      server = options.servers.find(server => {
        return !keys.find(listener => {
          return listener === server;
        });
      });
    }
    if (!server) {
      // It is already spun up everywhere
      return site;
    }
    if (server === options.server) {
      return spinUpHere(site);
    } else {
      return spinUpThere(site, server);
    }
  }

  async function spinUpThere(req, site, server) {
    req.headers['X-Apostrophe-Multisite-Spinup'] = 1;
    return attempt(req, res, { target: 'http://' + server });
  }

  async function spinUpHere(req, site) {
  
    // The available free-port-finder modules all have race conditions and
    // no provision for avoiding popular ports like 3000. Pick randomly and
    // retry if necessary. -Tom

    const port = Math.floor(lowPort + Math.random() * totalPorts);

    const apos = await require('util').promisify(run)(options.sites || {});

    site.listeners[options.server] = hostnameOnly(options.server) = ':' + port;
    const $set = {};
    $set['listeners.' + options.server] = site.listeners[options.server];
    await dashboard.docs.db.update({
      _id: site._id
    }, {
      $set: set
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

  async function spinUpDashboard() {

    // TODO: this function has a lot of code in common with spinUpHere.
    // Think about that. Should we support multiple constellations of
    // sites in a single process, and just make the dashboard a specialized
    // constellation at some point?

    // The available free-port-finder modules all have race conditions and
    // no provision for avoiding popular ports like 3000. Pick randomly and
    // retry if necessary. -Tom

    const port = Math.floor(lowPort + Math.random() * totalPorts);

    const apos = await require('util').promisify(run)(options.dashboard || {});
    
    return port;
    
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

            'sites-base': {
              extend: 'apostrophe-pieces',
              name: 'site',
              addFields: [
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
              ],
              construct: function(self, options) {
                self.beforeSave = function(req, doc, options, callback) {
                  doc.hostnames = _.filter((doc.hostnamesArray && doc.hostnamesArray.value) || [], function(value) {
                    return value.hostname.toLowerCase().trim();
                  });
                  return callback(null);
                };
              }
            },

            'sites': {
              extend: 'sites-base'
            }
          }
        }, config)
      );
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
    var path = require('path');
    return path.dirname(path.resolve(getRoot().filename));
  }

  function getNpmPath(root, type) {
    const npmResolve = require('resolve');
    return npmResolve.sync(type, { basedir: getRootDir() });
  }

};

