// cytoscape-elk ships no type declarations; it registers as a cytoscape
// extension via `cytoscape.use(elk)`.
declare module 'cytoscape-elk' {
  import type { Ext } from 'cytoscape'
  const ext: Ext
  export default ext
}
