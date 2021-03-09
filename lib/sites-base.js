const Promise = require('bluebird');
const _ = require('lodash');
const shellQuote = require('shell-quote').quote;
const compareVersions = require('compare-versions');

const exec = require('util').promisify(
  require('child_process').exec
);

module.exports = {
  extend: 'apostrophe-pieces',
  instantiate: false,
  name: 'site',
  beforeConstruct: function(self, options) {
    let ourAddFields, ourArrangeFields;
    if (options.baseUrlDomains) {
      const baseDomain = options.baseUrlDomains[process.env.ENV || 'dev'];
      ourAddFields = [
        {
          name: 'shortName',
          label: 'Short Name',
          help: `If the short name is "niftypig", then the temporary hostname of the site will be "niftypig.${baseDomain}". Defaults to the slug if empty`,
          type: 'string'
        },
        {
          name: 'prodHostname',
          label: 'Production Hostname',
          help: 'We will also automatically add "www." as an alternate. The final name of the site. Do not add unless the DNS is being changed or has been changed to point to this service',
          type: 'string'
        },
        {
          name: 'canonicalize',
          label: 'Redirect to Production Hostname',
          help: 'Do not activate this until you see that both DNS and HTTPS are working for the production hostname.',
          type: 'boolean',
          choices: [
            {
              value: true,
              showFields: ['canonicalizeStatus']
            },
            {
              value: false
            }
          ]
        },
        {
          name: 'canonicalizeStatus',
          label: 'Canonical Redirect Status Code',
          type: 'select',
          choices: [
            {
              label: '302 (Moved Temporarily)',
              value: '302'
            },
            {
              label: '301 (Moved Permanently)',
              value: '301'
            }
          ],
          def: '302',
          help: '"Moved Permanently" is best for SEO, but you should make sure you are happy with the results using "Moved Temporarily" first to avoid caching of bad redirects.'
        }
      ];

      ourArrangeFields = [
        {
          name: 'urls',
          label: 'URLs',
          fields: [
            'shortName',
            'prodHostname',
            'canonicalize',
            'canonicalizeStatus'
          ]
        }
      ];
    } else {
      ourAddFields = [
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
        },
        {
          name: 'devBaseUrl',
          label: 'Development Base URL',
          help: 'like http://localhost:3000',
          type: 'url'
        },
        {
          name: 'stagingBaseUrl',
          label: 'Staging Base URL',
          help: 'like http://project.staging.org',
          type: 'url'
        },
        {
          name: 'prodBaseUrl',
          label: 'Production Base URL',
          help: 'like https://myproject.com',
          type: 'url'
        }
      ];

      ourArrangeFields = [
        {
          name: 'urls',
          label: 'URLs',
          fields: [
            'hostnamesArray',
            'devBaseUrl',
            'stagingBaseUrl',
            'prodBaseUrl'
          ]
        }
      ];
    }

    options.addFields = ourAddFields.concat([
      {
        name: 'adminPassword',
        label: 'Admin Password',
        type: 'password',
        help: 'Set password for the "admin" user of the new site. For pre-existing sites, leave blank for no change.'
      },
      {
        name: 'redirect',
        label: 'Redirect Entire Site',
        type: 'boolean',
        help: 'Redirect all traffic for the site to another URL.',
        choices: [
          {
            value: true,
            showFields: ['redirectUrl', 'redirectPreservePath', 'redirectStatus']
          },
          {
            value: false
          }
        ]
      },
      {
        name: 'redirectUrl',
        label: 'Redirect To...',
        type: 'url',
        help: 'Redirect traffic to this URL.',
        required: true
      },
      {
        name: 'redirectPreservePath',
        label: 'Preserve the Path when Redirecting',
        type: 'boolean',
        help: 'If the URL ends with /something, add /something to the redirect URL as well. Otherwise, all traffic is redirected to a single place.'
      },
      {
        name: 'redirectStatus',
        label: 'Redirect Status Code',
        type: 'select',
        choices: [
          {
            label: '302 (Moved Temporarily)',
            value: '302'
          },
          {
            label: '301 (Moved Permanently)',
            value: '301'
          }
        ],
        def: '302',
        help: '"Moved Permanently" is best for SEO, but you should test thoroughly first with "Moved Temporarily" to avoid caching of bad redirects.'
      }
    ]).concat(options.addFields || []);

    options.arrangeFields = ourArrangeFields.concat([
      {
        name: 'password',
        label: 'Password',
        fields: ['adminPassword']
      },
      {
        name: 'redirectGroup',
        label: 'Redirect',
        fields: [
          'redirect',
          'redirectUrl',
          'redirectPreservePath',
          'redirectStatus'
        ]
      }
    ]).concat(options.arrangeFields || []);
  },

  construct: function(self, options) {
    self.beforeSave = function(req, doc, options, callback) {
      if ((!doc._id) && (!doc.copyOfId)) {
        if (!doc.adminPassword) {
          self.apos.notify(req, 'You must fill out the admin password field when creating a new site.', { type: 'error' });
          return callback('adminPassword.required');
        }
      }
      // Don't let an admin password wind up in the db in cleartext
      req.newAdminPassword = doc.adminPassword;
      delete doc.adminPassword;

      // new behavior
      if (self.options.baseUrlDomains) {
        const shortName = doc.shortName || doc.slug || self.apos.utils.slugify(doc.title || '');
        if (!shortName) {
          // Nothing to go on
          return callback(null);
        }
        // Most common mistakes: protocol in the shortname, domain name in the shortname
        if (shortName.match(/:|\.|\s/)) {
          self.apos.notify(req, 'The short name of the site must not contain dots, a protocol or spaces. It is a short name like "nifty" (without quotes) <F2>and will be used as a "working name" for a temporary subdomain for your site until it is launched.', { type: 'error' });
          return callback('invalid');
        }
        doc.hostnames = [];

        _.forOwn(self.options.baseUrlDomains, function(value, key) {
          const protocol = (key === 'dev') ? 'http://' : 'https://';
          doc[key + 'BaseUrl'] = protocol + shortName + '.' + value;
          doc.hostnames.push(shortName + '.' + value.replace(/:.*$/, ''));
        });

        if (doc.prodHostname) {
          doc.hostnames.push(doc.prodHostname);
          doc.prodHostname.includes('www') ? doc.hostnames.push(doc.prodHostname.replace('www.', '')) : doc.hostnames.push('www.' + doc.prodHostname);
          const protocol = 'https://';
          doc.prodBaseUrl = protocol + doc.prodHostname;
        }
      } else {
        // old behavior
        doc.hostnames = _.map(doc.hostnamesArray || [], function(value) {
          return value.hostname.toLowerCase().trim();
        });
      }

      return callback(null);
    };

    // Make sure we can distinguish a copy from a new site
    self.copyExtras = function(req, copyOf, piece, callback) {
      piece.copyOfId = copyOf._id;
      return callback(null);
    };

    // When a site is copied, replicate its attachments and database
    self.afterInsert = function(req, piece, options, callback) {

      // Shim callbacks to async/await

      body();

      async function body() {
        try {
          await copyContent(req, piece, options);
        } catch (e) {
          return callback(e);
        }
        return callback(null);
      }

      async function copyContent(req, piece, options) {

        if (!piece.copyOfId) {
          return;
        }

        // copy the database and the attachments
        await copyDatabase();
        const from = await getFrom();
        const to = await getTo();
        await purgeTrash();
        if (self.options.copy && self.options.copy.hardlink) {
          await hardlinkAttachments();
        } else {
          await copyAttachments();
        }

        async function copyDatabase() {
          const admin = self.apos.db.admin();
          const info = await admin.serverInfo();
          const shortNamePrefix = self.apos.shortName.replace(/dashboard$/, '');
          // The copydb command requires no utilities that might not be installed,
          // so we use it until we hit a mongod version that does not support it at all
          if (compareVersions(info.version, '4.2') < 0) {
            const command = {
              copydb: 1,
              fromdb: shortNamePrefix + piece.copyOfId,
              todb: shortNamePrefix + piece._id
            };
            return admin.command(command);
          } else {
            // The copyDb command is gone in mongodb >= 4.2, use
            // mongodump and mongorestore with --uri and --archive
            const fromDb = `${shortNamePrefix}${piece.copyOfId}`;
            const toDb = `${shortNamePrefix}${piece._id}`;
            const baseUri = new URL(self.apos.options.multisite.mongodbUrl);
            baseUri.pathname = `/${fromDb}`;
            const fromUri = baseUri.toString();
            baseUri.pathname = `/${toDb}`;
            const toUri = baseUri.toString();
            const cmd = shellQuote([ 'mongodump', `--uri=${fromUri}`, '--archive' ]) + ' | ' + shellQuote([ 'mongorestore', `--uri=${toUri}`, `--nsFrom=${fromDb}.*`, `--nsTo=${toDb}.*`, '--archive', '--drop' ]);
            return exec(cmd);
          }
        }

        async function getFrom() {
          return self.apos.options.multisite.getSiteApos(piece.copyOfId);
        }

        async function getTo() {
          return self.apos.options.multisite.getSiteApos(piece._id);
        }

        async function purgeTrash() {
          await to.docs.db.remove({ trash: true });
          await to.attachments.db.remove({ trash: true });
        }

        async function copyAttachments() {
          const copyOut = Promise.promisify(from.attachments.uploadfs.copyOut);
          const copyIn = Promise.promisify(to.attachments.uploadfs.copyIn);
          const unlink = Promise.promisify(require('fs').unlink);
          const attachments = await to.attachments.db.find({ trash: { $ne: true } }).toArray();
          return Promise.map(attachments, async function(attachment) {
            const files = [];
            files.push(from.attachments.url(attachment, {
              size: 'original',
              uploadfsPath: true
            }));
            _.each(from.attachments.uploadfs.options.imageSizes, function(size) {
              files.push(from.attachments.url(attachment, {
                size: size.name,
                uploadfsPath: true
              }));
            });
            _.each(attachment.crops, function(crop) {
              files.push(from.attachments.url(attachment, {
                crop: crop,
                size: 'original',
                uploadfsPath: true
              }));
              _.each(from.attachments.uploadfs.options.imageSizes, function(size) {
                files.push(from.attachments.url(attachment, {
                  crop: crop,
                  size: size.name,
                  uploadfsPath: true
                }));
              });
            });
            return Promise.map(files, async function(file) {
              const tempPath = getTempPath(file);
              try {
                await copyOut(file, tempPath);
              } catch (e) {
                console.error(e); // eslint-disable-line no-console
                console.error('Unable to copy ' + file + ' out to ' + tempPath + ', probably does not exist, continuing'); // eslint-disable-line no-console
                return;
              }
              await copyIn(tempPath, file);
              await unlink(tempPath);
            }, { concurrency: 1 });
          }, { concurrency: 5 });
        }

        // This is cheating. Really only suited to demos and other situations where
        // we're guaranteed to be using the local fs
        async function hardlinkAttachments() {
          const fs = require('fs');
          const root = to.attachments.uploadfs.options.uploadsPath;
          const original = `${root}/${piece.copyOfId}`;
          const copy = `${root}/${piece._id}`;
          if (!fs.existsSync(original)) {
            // Master has no media yet
            return;
          }
          fs.mkdirSync(copy);
          recursiveHardlink(original, copy);
          function recursiveHardlink(original, copy) {
            const contents = fs.readdirSync(original);
            for (const entry of contents) {
              const oldPath = `${original}/${entry}`;
              const newPath = `${copy}/${entry}`;
              if (fs.lstatSync(oldPath).isDirectory()) {
                fs.mkdirSync(newPath);
                recursiveHardlink(oldPath, newPath);
              } else {
                fs.linkSync(oldPath, newPath);
              }
            }
          }
        }

        // Trusts the extension because it was already in uploadfs. -Tom
        function getTempPath(file) {
          return to.attachments.uploadfs.getTempPath() + '/' + require('path') + self.apos.utils.generateId() + require('path').extname(file);
        }
      }
    };

    self.afterSave = async function(req, piece, options, callback) {

      try {
        if (req.newAdminPassword) {
          await setAdminUser(req.newAdminPassword, piece, options);
        }
        return callback(null);
      } catch (e) {
        return callback(e);
      }

      async function setAdminUser(password, piece, options) {
        const apos = await self.apos.options.multisite.getSiteApos(piece._id);
        const req = apos.tasks.getReq();
        const admin = await apos.users.find(req, { username: 'admin' }).toObject();
        if (admin) {
          admin.password = password;
          return apos.users.update(req, admin);
        } else {
          const user = {
            username: 'admin',
            firstName: 'Admin',
            lastName: 'User',
            title: 'admin',
            password
          };
          let group = await apos.groups.find(req, {
            permissions: {
              $in: ['admin']
            }
          }).toObject();
          if (!group) {
            group = await apos.groups.insert(req, {
              title: 'admin',
              permissions: ['admin']
            });
          }
          user.groupIds = [group._id];
          return apos.users.insert(apos.tasks.getReq(), user);
        }
      }
    };

    self.addTask('remove-orphans', 'Remove orphaned sites (db exists, but no matching site\ndoc). These will be temporary sites that did not get cleaned up. They\nnormally do not have any media in uploadfs, but if they do be aware it is\nnot cleaned up.', async function(apos, argv) {
      const req = self.apos.tasks.getReq();
      const dbs = await self.apos.db.admin().listDatabases({ nameOnly: true });
      const prefix = self.apos.shortName.replace(/dashboard$/, '');
      // Make sure the dashboard is never a candidate to be removed
      const names = dbs.databases.map(db => db.name).filter(db => db.startsWith(prefix) && (db !== `${prefix}dashboard`));
      const known = await self.find(req, {}).trash(null).published(null).toArray().map(site => prefix + site._id);
      const remove = _.difference(names, known);
      for (const name of remove) {
        console.log(`dropping ${name}`); // eslint-disable-line no-console
        await self.apos.db.db(name).dropDatabase();
      }
    });

    self.addTask('transition-shortname', 'Convert first element of hostname array to shortname in order to use baseUrlDomains.', async function(apos, argv) {
      const req = self.apos.tasks.getReq();
      // Even sites in the trash etc. should have sensible properties in case they are revived
      const sites = await self.find(req, {}).published(null).trash(null).toArray();
      for (const site of sites) {
        if (suitable(site.stagingBaseUrl)) {
          const url = new URL(site.stagingBaseUrl);
          if (url.hostname) {
            site.shortName = url.hostname.split('.')[0];
          }
        }
        if (!site.shortName) {
          if (suitable(site.prodBaseUrl)) {
            const url = new URL(site.prodBaseUrl);
            if (url.hostname) {
              site.shortName = url.hostname.split('.')[0];
            }
          }
        }
        if (!site.shortName) {
          if (suitable(site.devBaseUrl)) {
            const url = new URL(site.devBaseUrl);
            if (url.hostname) {
              site.shortName = url.hostname.split('.')[0];
            }
          }
        }
        if (!site.shortName) {
          if (!site.trash) {
            self.apos.utils.warn('Warning: had to set the shortName to ' + site.slug + ' for ' + site.title + ' due to a lack of candidates in the legacy BaseUrl settings.', site.devBaseUrl, site.stagingBaseUrl, site.prodBaseUrl);
            site.shortName = site.slug;
          }
        }
        if (site.prodBaseUrl) {
          try {
            const url = new URL(site.prodBaseUrl);
            if (url.hostname && (url.hostname !== (site.shortName + '.' + self.options.baseUrlDomains.prod))) {
              site.prodHostname = url.hostname;
            }
          } catch (e) {
            // Hey, we tried; it was a bad URL
          }
        }
        await self.update(req, site);
      }

      function suitable(s) {
        if (!s) {
          return false;
        }
        let url;
        try {
          url = new URL(s);
        } catch (e) {
          return false;
        }
        if (url && url.hostname) {
          url.hostname = url.hostname.replace(/^www\./, '');
          const dots = ((url.hostname.match(/\./g) || []).length);
          if ((!dots) || (dots > 1)) {
            return true;
          }
        }
      }
    });

    self.apos.migrations.add('sites:fixProdHostname', async function() {
      return self.apos.migrations.eachDoc({
        type: 'site'
      }, async function(site) {
        if (!site.prodHostname) {
          return;
        }
        if (site.prodBaseUrl.match(/^https?:/)) {
          return;
        }
        self.apos.utils.log('adding protocol to prodBaseUrl for ', site._id + ': ' + site.prodHostname);
        return self.apos.docs.db.update({
          _id: site._id
        }, {
          $set: {
            prodBaseUrl: 'https://' + site.prodHostname
          }
        });
      });
    });

  }
};
