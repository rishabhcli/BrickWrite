import { createServer, isRunnableDevEnvironment } from 'vite'
const server = await createServer({
  root: '/Users/m3-max/Documents/GitHub/BrickWrite',
  configFile: false,
  server: { middlewareMode: true, watch: null },
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true },
})
console.log('ssrLoadModule?', typeof server.ssrLoadModule)
const env = server.environments.ssr
console.log('runnable?', isRunnableDevEnvironment(env))
const runner = env.runner
const v = await runner.import('/src/cad/validation.ts')
console.log('validation OK', typeof v.validateDocument)
const a = await runner.import('/src/cad/assembly.ts')
console.log('assembly OK', typeof a.planWall)
const r = await runner.import('/src/cad/raster.ts')
console.log('raster OK', typeof r.renderScene)
const c = await runner.import('/src/cad/collision.ts')
console.log('collision OK', typeof c.findCollisions)
await server.close()
