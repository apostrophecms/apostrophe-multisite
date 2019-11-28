const rp = require('request-promise')
const enableDestroy = require('server-destroy')

describe('Apostrophe-multisite', function() {
  describe('#dashboard', function() {

    let dashboard

    beforeEach(async() => {
      dashboard = await require('../index.js')({
         dashboardHostname: [
           'dashboard.t'
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
             'apostrophe-pages': {
               choices: [
                 {
                   label: 'Home',
                   name: 'home'
                 },
                 {
                   label: 'Default',
                   name: 'default'
                 }
               ]
             }
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
           }
         }
       })
    })

    afterEach(() => {
      console.log('=================> PASSING HERE !! <=================')
      enableDestroy(dashboard.server)
      dashboard.server.destroy()
    })

    it('starts multisite', async function() {
      const site = dashboard.apos.sites.newInstance()
      const newSite = {
        title: 'New Site',
        slug: 'new-site',
        adminPassword: 'admin',
        devBaseUrl: 'site.t'
      }
      const req = dashboard.apos.tasks.getReq()
      const piece = await dashboard.apos.sites.insert(req, {...site, ...newSite})
      const found = await dashboard.apos.sites.find(req, { _id: piece._id}).toObject()
      console.log('found', require('util').inspect(found, { colors: true, depth: 1 }))

      // const siteT = await rp('http://site.t:3000')
      // console.log('siteT', require('util').inspect(siteT, { colors: true, depth: 1 }))
    })
  });
});