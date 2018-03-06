const _ = require('lodash');
const mongo = require('mongodb');
const fs = require('fs');
const argv = require('boring')();
const quote = require('shell-quote');

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
      console.log('winning site is ' + site.hostnames[0]);
      let winner;

      if (req.headers['X-Apostrophe-Multisite-Spinup']) {
        console.log('we spin it up');
        if (!site.listeners[options.server]) {
          console.log('new');
          site = await spinUpHere(site);
        }
        console.log('existing');
        winner = options.server;
      } else {
        console.log('awaiting spinUpAsNeeded');
        site = await spinUpAsNeeded(req, site);
      }

      let retried;
      do {
        retried = false;
        const keys = Object.keys(site.listeners);
        const winningServer = keys[Math.floor(Math.random() * keys.length)];
        winner = site.listeners[winningServer];
        console.log('winner is ' + winner);
        const attempt = require('util').promisify(proxy.web.bind(proxy));
        try {
          console.log('attempting to ' + winner);
          await attempt(req, res, { target: 'http://' + winner });
          console.log('after');
        } catch (e) {
          console.log('fail');
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
    console.log('returning from spinUpAsNeeded');
    return site;
  }

  async function spinUp(req, site) {
    const name = (site.hostnames && site.hostnames[0]) || site._id;
    console.log('Spinning up ' + name + ' somewhere...');
    // Where should it be spun up?
    // Preference for a separate physical server
    const keys = Object.keys(site.listeners);
    let server = options.servers.find(server => {
      return !keys.find(listener => {
        return hostnameOnly(listener) === hostnameOnly(server);
      });
    });
    if (server) {
      console.log('remote server chosen: ' + server);
    }
    if (!server) {
      // Settle for a different core
      server = options.servers.find(server => {
        return !keys.find(listener => {
          return listener === server;
        });
      });
      console.log('local server chosen: ' + server);
    }
    if (!server) {
      // It is already spun up everywhere
      console.log('already spun up everywhere');
      return site;
    }
    if (server === options.server) {
      return spinUpHere(site);
    } else {
      return spinUpThere(req, site, server);
    }
  }

  async function spinUpThere(req, site, server) {
    const name = (site.hostnames && site.hostnames[0]) || site._id;
    console.log('Passing on request to spin up ' + name + ' to a peer server...');
    req.headers['x-apostrophe-multisite-spinup'] = 1;
    req.rawHeaders.push('X-Apostrophe-Multisite-Spinup', '1');
    const attempt = require('util').promisify(proxy.web.bind(proxy));
    console.log('proxying to ' + server);
    return attempt(req, req.res, { target: 'http://' + server });
  }

  async function spinUpHere(site) {

    const name = (site.hostnames && site.hostnames[0]) || site._id;
    console.log('Spinning up ' + name + ' here...');

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
              extend: 'sites-base'
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
    const sites = await dashboard.sites.find(req, {});
    const exec = require('child_process').execSync;
    sites.forEach(site => {
      console.log('Site ' + site._id + ': ' + exec(quote(process.argv[0]) + ' ' +
        argv._.map(arg => quote).join(' ') +
        Object.keys(argv).filter(k => k !== '_').map(param => {
          return '--' + param + '=' + quote(argv[param]);
        }) +
        '--site=' + site._id
      ));
    });
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

