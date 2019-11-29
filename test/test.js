const del = require('del');
const mongo = require('mongodb');
const { expect } = require('chai');
const rp = require('request-promise');
const enableDestroy = require('server-destroy');
const apostropheMultisite = require('../index.js');

describe('Apostrophe-multisite', function() {
  describe('#dashboard', function() {
    const admin = 'admin';
    const port = 3000;
    const modules = {
      'apostrophe-users': {
        groups: [
          {
            title: 'admin',
            permissions: ['admin']
          }
        ]
      },
      'apostrophe-pages': {},
      'apostrophe-templates': {}
    };
    const title = 'New Site';
    const url = 'site.test';
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
      //remove temp files
      await del(['./test/sites/data']);

      // find and remove test dbs
      const db = await mongo.MongoClient.connect('mongodb://localhost:27017');
      const adminDb = db.admin();
      const { databases } = await adminDb.listDatabases();
      for (const db of databases) {
        if (db.name.match(/^test-multi-/)) {
          const client = new mongo.Db(db.name, new mongo.Server('localhost', 27017));
          await client.open();
          await client.dropDatabase();
          console.log('\x1b[36m%s\x1b[0m', `Test db ${db.name} dropped`);
        }
      }

      // configure fake app using apostrophe-multisite
      multisite = await apostropheMultisite({
        port,
        sessionSecret: 'test123',
        shortNamePrefix,
        sites: { modules },
        dashboard: { modules },
        dashboardHostname: 'dashboard.test'
      });
      sites = multisite.apos.sites;
      site = sites.newInstance();
      req = multisite.apos.tasks.getReq();
    });

    after(() => {
      enableDestroy(multisite.server);
      multisite.server.destroy();
    });

    it('starts the dashboard', async function() {
      expect(multisite)
        .to.be.an('object')
        .that.has.any.keys('apos', 'server');
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
      expect(dashboard).to.have.string('"csrfCookieName":"test-multi-dashboard.csrf"');
    });

    it('creates an admin user for the dashboard', async function() {
      const adminGroup = await multisite.apos.groups.find(req, { title: admin }).toObject();
      const adminUser = await multisite.apos.users.insert(req, {
        username: admin,
        password: admin,
        title: admin,
        groupIds: [adminGroup._id]
      });
      expect(adminUser).to.have.property('type', 'apostrophe-user');

      try {
        await rp({
          method: 'POST',
          uri: `http://dashboard.test:${port}/login`,
          body: {
            username: admin,
            password: admin
          },
          json: true
        });
      } catch (error) {
        expect(error).to.have.property('statusCode', 302);
      }
    });

    it('connects to the newly created site', async function() {
      const piece = await sites.insert(req, {
        ...site,
        ...newSite,
        devBaseUrl: 'site2.test',
        hostnamesArray: [
          {
            hostname: 'site2.test'
          }
        ]
      });
      const siteT = await rp(`http://site2.test:${port}`);
      expect(siteT).to.have.string('Home');
      expect(siteT).to.have.string(`"csrfCookieName":"test-multi-${piece._id}.csrf"`);

      try {
        await rp({
          method: 'POST',
          uri: `http://site2.test:${port}/login`,
          body: {
            username: admin,
            password: admin
          },
          json: true
        });
      } catch (error) {
        expect(error).to.have.property('statusCode', 302);
      }
    });
  });
});
