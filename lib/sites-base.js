var Promise = require('bluebird');
var _ = require('lodash');

module.exports = function(self, options) {
  self.beforeSave = function(req, doc, options, callback) {
    doc.hostnames = _.map(doc.hostnamesArray || [], function(value) {
      return value.hostname.toLowerCase().trim();
    });
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
        await afterInsert(req, piece, options);
      } catch (e) {
        return callback(e);
      }
      return callback(null);
    }

    async function afterInsert(req, piece, options) {

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
};
