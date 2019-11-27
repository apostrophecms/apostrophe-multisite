var Promise = require('bluebird');
var _ = require('lodash');

module.exports = {
  extend: 'apostrophe-pieces',
  instantiate: false,
  name: 'site',
  beforeConstruct: function(self, options) {
    if (options.baseUrlDomains) {
      options.addFields = [
        {
          name: 'shortName',
          label: 'Shortname',
          help: 'defaults to the slug if empty',
          type: 'string'
        },
        {
          name: 'productionHostname',
          label: 'Production Hostname',
          help: 'will add "www." if not present',
          type: 'string'
        }
      ].concat(options.addFields || []);

      options.arrangeFields = [
        {
          name: 'urls',
          label: 'URLs',
          fields: [
            'shortName',
            'productionHostname',
          ]
        }
      ].concat(options.arrangeFields || []);
    } else {
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
      ].concat(options.addFields || []);

      options.arrangeFields = [
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
      ].concat(options.arrangeFields || []);
    }

    options.addFields = [
      {
        name: 'adminPassword',
        label: 'Admin Password',
        type: 'password',
        help: 'Set password for the "admin" user of the new site. For pre-existing sites, leave blank for no change.'
      }
    ].concat(options.addFields || []);

    options.arrangeFields = [
      {
        name: 'password',
        label: 'Password',
        fields: [ 'adminPassword' ]
      }
    ].concat(options.arrangeFields || []);
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
  
      if (self.options.baseUrlDomains) {
        // new behavior
        const shortName = doc.shortName || doc.slug;
        doc.hostnames = [];

        _.forOwn(self.options.baseUrlDomains, function(value, key) {
          doc[key + 'BaseUrl'] = shortName + '.' + self.options.baseUrlDomains[key].toLowerCase().trim();
          doc.hostnames.push(shortName + '.' + value.toLowerCase().trim());
        });

        if (doc.productionHostname) {
          doc.hostnames.push(doc.productionHostname);
          doc.productionHostname.includes('www') ? doc.hostnames.push(doc.productionHostname.replace('www.', '')) : doc.hostnames.push('www.' + doc.productionHostname);
          doc.prodBaseUrl = doc.productionHostname;
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
  
        let from, to;
  
        // copy the database and the attachments
        await copyDatabase();
        from = await getFrom();
        to = await getTo();
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
          return await admin.command(command);
        }
  
        async function getFrom() {
          return await self.apos.options.multisite.getSiteApos(piece.copyOfId);
        }
  
        async function getTo() {
          return await self.apos.options.multisite.getSiteApos(piece._id);
        }
  
        async function purgeTrash() {
          await to.docs.db.remove({ trash: true });
          await to.attachments.db.remove({ trash: true });
        }
        
        async function copyAttachments() {
          const copyOut = Promise.promisify(from.attachments.uploadfs.copyOut);
          const copyIn = Promise.promisify(to.attachments.uploadfs.copyIn);
          const unlink = Promise.promisify(require('fs').unlink);
          let attachments = await to.attachments.db.find({ trash: { $ne: true } }).toArray();
          return Promise.map(attachments, async function(attachment) {
            let files = [];
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
                console.error(e);
                console.error('Unable to copy ' + file + ' out to ' + tempPath + ', probably does not exist, continuing');
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
            for (let entry of contents) {
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
          console.log(admin);
          return apos.users.update(req, admin);
        } else {
          const user = {
            username: 'admin',
            firstName: 'Admin',
            lastName: 'User',
            title: 'admin',
            password
          };
          const group = await apos.groups.find(req, {
            permissions: {
              $in: [ 'admin' ]
            }
          }).toObject();
          if (!group) {
            group = await apos.groups.insert(req, {
              title: 'admin',
              permissions: [ 'admin' ]
            });
          }
          user.groupIds = [ group._id ];
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
        const id = name.replace(prefix, '');
        const base = prefix.replace(/-$/, '');
        console.log(`dropping ${name}`);
        await self.apos.db.db(name).dropDatabase(); 
      }
    });
  
    self.addTask('transition-shortname', 'Convert first element of hostname array to shortname in order to use baseUrlDomains.', async function(apos, argv) {
      const req = self.apos.tasks.getReq();
      const sites = await self.find(req, {}).toArray();
      for (const site of sites) {
        if (!site.shortName && site.hostnamesArray && site.hostnamesArray.length) {
          site.shortName = site.hostnamesArray[0].hostname.split('.')[0];
          console.log(`creating shortname in ${site.title}`);
          await self.update(req, site);
        }
      }
      console.log('task ended');
    });
  }
};
