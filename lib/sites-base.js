const Promise = require('bluebird');
const _ = require('lodash');
const util = require('util');

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
        }
      ];

      ourArrangeFields = [
        {
          name: 'urls',
          label: 'URLs',
          fields: [
            'shortName',
            'prodHostname',
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
      }
    ]).concat(options.addFields || []);

    options.arrangeFields = ourArrangeFields.concat([
      {
        name: 'password',
        label: 'Password',
        fields: ['adminPassword']
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
      if (!doc._id) {
        doc._id = self.generateShortId();
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
        if (shortName.match(/\:|\.|\s/)) {
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

    // Generate an id only 13 characters long that still has
    // 36**13 possible values, a large enough namespace to
    // rule out brute force guessing. We need this because
    // of the 38 byte limit on database names in MongoDB
    // Atlas M0/M2/M5 tiers. 13 characters plus hyphen leaves
    // a reasonable 24 characters for a prefix matching the
    // repo name, which is good practice to prevent collisions
    // when sharing a mongodb instance between projects
    // (usually but not necessarily just in dev)
 
    self.generateShortId = function() {
      const fd = fs.openSync('/dev/urandom', 'r');
      const buffer = Buffer.alloc(100);
      let id = '';
      fs.readSync(fd, buffer, 0, 100);
      let n = 0;
      for (let i = 0; (i < 13); i++) {
        // Since 36 does not go evenly into 256, we have to discard
        // bytes that would bias the results toward the remainder.
        while (buffer[n] >= (7 * 36)) {
          n++;
          if (n === 100) {
            // It would be fun to do the math on whether
            // this is ever going to happen, probabilistically
            // speaking
            fs.readSync(fd, buffer, 0, 100);
            n = 0;
          }
        }
        const v = buffer[n++] % 36;
        if (v < 26) {
          id += String.fromCharCode(97 + v);
        } else {
          id += String.fromCharCode(48 + (v - 26));
        }
      }
      fs.closeSync(fd);
      return id;
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
          const shortNamePrefix = self.apos.shortName.replace(/dashboard$/, '');
          // http://stackoverflow.com/questions/36403749/how-can-i-execute-db-copydatabase-through-nodejss-mongodb-native-driver
          const command = {
            copydb: 1, fromdb: shortNamePrefix + piece.copyOfId, todb: shortNamePrefix + piece._id
          };
          const admin = self.apos.db.admin();
          return admin.command(command);
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
            files.push(from.attachments.url(attachment, { size: 'original', uploadfsPath: true }));
            _.each(from.attachments.uploadfs.options.imageSizes, function(size) {
              files.push(from.attachments.url(attachment, { size: size.name, uploadfsPath: true }));
            });
            _.each(attachment.crops, function(crop) {
              files.push(from.attachments.url(attachment, { crop: crop, size: 'original', uploadfsPath: true }));
              _.each(from.attachments.uploadfs.options.imageSizes, function(size) {
                files.push(from.attachments.url(attachment, { crop: crop, size: size.name, uploadfsPath: true }));
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
      const dbs = await self.apos.db.admin().listDatabases();
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
            console.log('Warning: had to set the shortName to ' + site.slug + ' for ' + site.title + ' due to a lack of candidates in the legacy BaseUrl settings.', site.devBaseUrl, site.stagingBaseUrl, site.prodBaseUrl);
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
        console.log('adding protocol to prodBaseUrl for ', site._id + ': ' + site.prodHostname);
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
