const del = require('del');
const mongo = require('emulate-mongo-2-driver');
const { expect } = require('chai');
const rp = require('request-promise');
const enableDestroy = require('server-destroy');
const apostropheMultisite = require('./app.js');
const Promise = require('bluebird');

describe('Apostrophe-multisite', function() {
  describe('maxRequestsBeforeShutdown', function() {
    const port = 3000;
    const admin = 'admin';
    const url = 'site.test';
    const title = 'New Site';
    const shortNamePrefix = 'test-multi-';

    let multisite;
    let sites;
    let site;
    let req;
    let exited;

    const newSite = {
      title,
      slug: 'new-site',
      adminPassword: admin,
      devBaseUrl: url,
      hostnamesArray: [
        {
          hostname: url
        }
      ]
    };

    before(async () => {
      // remove temp files
      await del(['./test/sites/data']);

      // find and remove test dbs
      const mongodbUrl =
        process.env.MONGODB_SERVER && process.env.MONGODB_PORT
          ? `mongodb://${process.env.MONGODB_SERVER}:${process.env.MONGODB_PORT}`
          : 'mongodb://localhost:27017';
      const db = await mongo.MongoClient.connect(mongodbUrl);
      const adminDb = db.admin();
      const maxRequestsBeforeShutdown = 10;
      const additionalRequestsBeforeShutdown = 5;
      const { databases } = await adminDb.listDatabases();
      for (const db of databases) {
        if (db.name.match('[^,]*' + shortNamePrefix + '*')) {
          const client = await mongo.MongoClient.connect(mongodbUrl + '/' + db.name);
          await client.dropDatabase();
          console.log('\x1b[36m%s\x1b[0m', `Test db ${db.name} dropped`);
        }
      }

      function exit() {
        // Mock out process.exit for the test
        exited = true;
      }

      // configure fake app using apostrophe-multisite
      multisite = await apostropheMultisite({ maxRequestsBeforeShutdown, additionalRequestsBeforeShutdown, exit, port, shortNamePrefix, mongodbUrl });
      sites = multisite.dashboard.sites;
      site = sites.newInstance();
      req = multisite.dashboard.tasks.getReq();
    });

    after(() => {
      enableDestroy(multisite.server);
      multisite.server.destroy();
    });

    it('inserts a site and can find it', async function() {
      const piece = await sites.insert(req, { ...site, ...newSite });
      expect(piece).to.be.an('object');
      expect(piece).to.have.property('published', true);
      expect(piece).to.have.property('title', title);
      expect(piece).to.have.property('devBaseUrl', url);
      expect(piece.slug).to.match(/^new-site/);

      const found = await sites.find(req, { _id: piece._id }).toObject();
      expect(found).to.be.an('object');
      expect(found).to.have.property('published', true);
      expect(found).to.have.property('title', title);
      expect(found).to.have.property('devBaseUrl', url);
      expect(found.slug).to.match(/^new-site/);
    });

    it('should be able to fetch the new site home page between 10 and 15 times before being shut down by maxRequestsBeforeShutdown', async function() {
      let connected = 0;
      for (let i = 0; (i < 20); i++) {
        try {
          await rp(`http://site.test:${port}/`);
          connected++;
        } catch (e) {
          // Some of them should fail
        }
        // Give the shutdown mechanism time to work or these could all queue and succeed while
        // it is still running
        await Promise.delay(100);
      }
      expect(connected).to.be.below(16);
      expect(connected).to.be.above(9);
      expect(exited).to.be.true; // eslint-disable-line no-unused-expressions
    });
  });
});
