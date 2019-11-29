const mongo = require('mongodb')
const del = require('del');
const { expect } = require('chai')
const rp = require('request-promise')
const enableDestroy = require('server-destroy')
const apostropheMultisite = require('../index.js')

describe('Apostrophe-multisite', function() {
  describe('#dashboard', function() {

    let multisite
    let sites
    let site
    let req

    const newSite = {
      title: 'New Site',
      slug: 'new-site',
      adminPassword: 'admin',
      // devBaseUrl: 'site.test'
    }

    before(async() => {
      //remove temp files
      await del(['./test/sites/data'])

      // find and remove test dbs
      const db = await mongo.MongoClient.connect('mongodb://localhost:27017')
      const adminDb = db.admin()
      const { databases } = await adminDb.listDatabases()
      for(const db of databases) {
        if (db.name.match(/^multisite-/)) {
          const client = new mongo.Db(db.name, new mongo.Server('localhost', 27017))
          await client.open()
          await client.dropDatabase()
          console.log('\x1b[36m%s\x1b[0m', `Test db ${db.name} dropped`)
        }
      }

      // configure fake app using apostrophe-multisite
      multisite = await apostropheMultisite({
         dashboardHostname: [
           'dashboard.test'
         ],
         sessionSecret: 'test123',

         sites: {
           modules: {
             'apostrophe-users': {
               groups: [
                 {
                   title: 'admin',
                   permissions: [ 'admin' ]
                 }
               ]
             },
             'apostrophe-pages': {},
             'apostrophe-templates': {}
           }
         },

         dashboard: {
           modules: {
             'apostrophe-users': {
               groups: [
                 {
                   title: 'admin',
                   permissions: [ 'admin' ]
                 }
               ]
             },
             'apostrophe-pages': {
              park: [
                 {
                   title: 'Default',
                   type: 'default',
                   slug: '/default',
                   published: true,
                   orphan: true
                 }
               ],
             },
             'apostrophe-templates': {},
           }
         }
       })
       sites = multisite.apos.sites
       site = sites.newInstance()
       req = multisite.apos.tasks.getReq()
    })

    after(() => {
      enableDestroy(multisite.server)
      multisite.server.destroy()
    })

    it('starts the dashboard', async function() {
      expect(multisite).to.be.an('object').that.has.any.keys('apos', 'server')
    })

    it('creates a site', async function() {
      expect(site).to.be.an('object')
      expect(site.type).to.equal('site')
    })

    it('inserts a site and can find it', async function() {
      const piece = await sites.insert(req, {...site, ...newSite})
      expect(piece).to.be.an('object')
      expect(piece).to.have.property('published', true)
      expect(piece).to.have.property('title', 'New Site')
      expect(piece).to.have.property('devBaseUrl', 'new-site.t')
      expect(piece.slug).to.match(/^new-site/)

      const found = await sites.find(req, { _id: piece._id}).toObject()
      expect(found).to.be.an('object')
      expect(found).to.have.property('published', true)
      expect(found).to.have.property('title', 'New Site')
      expect(found).to.have.property('devBaseUrl', 'new-site.t')
      expect(found.slug).to.match(/^new-site/)
    })

    it.only('connects to the dashboard', async function() {
      const dashboard = await rp('http://dashboard.test:3000')
      expect(dashboard).to.have.string('<title>\n  \n    Home\n  \n</title>')
      expect(dashboard).to.have.string(' <body class=" " data-apos-level="0">\n    \n    \n\n    \n      \n    \n    <div class="apos-refreshable" data-apos-refreshable>\n      \n  <header>\n    <nav class="o-container c-navigation">\n    \n    </nav>\n  </header>\n\n      <a name="main"></a>\n      \n      Home\n      \n      \n  <footer>\n\n  </footer>\n\n    </div>\n    <script>\nwindow.apos = {"prefix":"","csrfCookieName":"multisite-dashboard.csrf","uploadsUrl":"/uploads/dashboard"}\n</script>\n<script src="/modules/apostrophe-browser-utils/js/lean.js"></script>\n    \n      <script type="text/javascript">\n        \n        \n      </script>\n    \n    \n    \n  \n\n  </body>')
    })

    it('connects to the newly created site', async function() {
      // const siteT = await rp('http://site.t:3000')
      // console.log('siteT', require('util').inspect(siteT, { colors: true, depth: 1 }))
    })
  });
});