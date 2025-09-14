import debug from 'debug'
import { esConnect } from './client/elasticsearch.js'
import { printVersion } from './service/printVersion.js'
import { startServer } from './swagger.js'

const logger = debug('api')

startServer().then(() => {
  logger('connecting es client')
  const p1 = esConnect().then(esClient => {
    global.esClient = esClient
    logger('es client connected')
  })
  p1.then(() => {
    console.log('=====================')
    console.log('Addressr - API Server')
    console.log('=====================')

    printVersion()
  })
})
