// elkjs run with its own worker (the elk-worker build, bundled by Vite's
// ?worker import); we use only the constructor + layout().
declare module 'elkjs/lib/elk-api.js' {
  interface ELKConstructorArgs {
    workerFactory?: (url?: string) => Worker
  }
  export default class ELK {
    constructor(args?: ELKConstructorArgs)
    layout(graph: unknown): Promise<unknown>
  }
}
declare module 'elkjs/lib/elk-worker.min.js?worker' {
  const WorkerFactory: { new (): Worker }
  export default WorkerFactory
}
