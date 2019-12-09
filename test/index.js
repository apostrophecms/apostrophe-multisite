const del = require('del');
const mongo = require('emulate-mongo-2-driver');
const { expect } = require('chai');
const rp = require('request-promise');
const enableDestroy = require('server-destroy');
const apostropheMultisite = require('./app.js');

describe('Apostrophe-multisite', function() {
  describe('#dashboard', function() {
    const port = 3000;
    const admin = 'admin';
    const url = 'site.test';
    const title = 'New Site';
    const shortNamePrefix = 'test-multi-';

    let multisite;
    let sites;
    let site;
    let req;

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
      const { databases } = await adminDb.listDatabases();
      for (const db of databases) {
        if (db.name.match('[^,]*' + shortNamePrefix + '*')) {
          const client = await mongo.MongoClient.connect(mongodbUrl + '/' + db.name);
          await client.dropDatabase();
          console.log('\x1b[36m%s\x1b[0m', `Test db ${db.name} dropped`);
        }
      }

      // configure fake app using apostrophe-multisite
      multisite = await apostropheMultisite({ port, shortNamePrefix, mongodbUrl });
      sites = multisite.dashboard.sites;
      site = sites.newInstance();
      req = multisite.dashboard.tasks.getReq();
    });

    after(() => {
      enableDestroy(multisite.server);
      multisite.server.destroy();
    });

    it('starts the dashboard', async function() {
      expect(multisite)
        .to.be.an('object')
        .that.has.any.keys('getSiteApos', 'dashboard', 'server');
    });

    it('creates a site', async function() {
      expect(site).to.be.an('object');
      expect(site.type).to.equal('site');
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

    it('connects to the dashboard', async function() {
      const dashboard = await rp(`http://dashboard.test:${port}`);
      expect(dashboard).to.have.string('Home');
      expect(dashboard).to.have.string(`"csrfCookieName":"${shortNamePrefix}dashboard.csrf"`);
    });

    it('creates an admin user for the dashboard', async function() {
      const adminGroup = await multisite.dashboard.groups.find(req, { title: admin }).toObject();
      const adminUser = await multisite.dashboard.users.insert(req, {
        username: admin,
        password: admin,
        title: admin,
        groupIds: [adminGroup._id]
      });
      expect(adminUser).to.have.property('type', 'apostrophe-user');

      const response = await rp({
        method: 'POST',
        uri: `http://dashboard.test:${port}/login`,
        body: {
          username: admin,
          password: admin
        },
        json: true,
        simple: false,
        resolveWithFullResponse: true
      });
      expect(response).to.have.property('statusCode', 302);
    });

    it('connects to the newly created site', async function() {
      const piece = await sites.insert(req, {
        ...site,
        ...newSite,
        devBaseUrl: 'site2.test',
        hostnamesArray: [{ hostname: 'site2.test' }]
      });
      const siteT = await rp(`http://site2.test:${port}`);
      expect(siteT).to.have.string('Home');
      expect(siteT).to.have.string(`"csrfCookieName":"${shortNamePrefix}${piece._id}.csrf"`);

      const response = await rp({
        method: 'POST',
        uri: `http://site2.test:${port}/login`,
        body: {
          username: admin,
          password: admin
        },
        json: true,
        simple: false,
        resolveWithFullResponse: true
      });
      expect(response).to.have.property('statusCode', 302);
    });
  });
});
