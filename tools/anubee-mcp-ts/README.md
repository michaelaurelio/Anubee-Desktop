# anubee-mcp

MCP server that lets your agent interact with Anubee-Desktop

## Prerequisite

This server does not read run files on its own. It talks to the **running**
Anubee Desktop app over a loopback control server.

1. Start Anubee Desktop.
2. Toggle **MCP control** ON in the app's MCP panel. This starts the loopback
   control server and writes the handshake file this server reads to find the
   port and token.

With the app closed, or MCP control off, every tool returns:

```
no running Anubee Desktop with MCP control enabled
```

The handshake file lives in the app's user-data directory (override with the
`ANUBEE_DESKTOP_USERDATA` environment variable).

## Build and register

```bash
cd tools/anubee-mcp-ts
npm install
npm run build        # tsc -> dist/index.js
claude mcp add anubee -- node /<path-to-directory>/Anubee-Desktop/tools/anubee-mcp-ts/dist/index.js
```
## Tools

Tools are grouped by tier. Most take an optional `runId` (defaults to the
active run) and an optional `filter` object.

### Reads

- `list_runs` - list loaded runs with event counts
- `coverage` - coverage summary for a run
- `query` - page through syscall/function events matching a filter
- `count` - count events matching a filter
- `get_event` - fetch one event by id
- `record_chain` - fetch the record chain around an event id
- `node_events` - page through the events behind a graph node
- `node_event_count` - count the events behind a graph node
- `graph_slice` - graph slice (nodes and edges) for a filter
- `stack_rollup` - rolled-up call stacks for a filter
- `node_offsets` - module-relative call-site offsets for a graph node
- `highlight_sets` - node/edge highlight sets for a graph node
- `diff_table` - diff two runs as a table
- `diff_slice` - diff two runs for one graph node
- `rasp_suggest` - RASP/anti-tamper suggestions for a run
- `rasp_rules_get` - builtin, global, project and effective RASP rules
- `tags_load` - load the saved tags for a run
- `tags_orphans` - which tag targets no longer exist in a run
- `dismissed_get` - load dismissed suggestions for a run
- `native_libs` - table of native libraries seen in a run
- `backtraces` - resolved backtrace frames for an event id or a node id
- `get_view` - what the user is looking at now (run, tab, filters, selected record and node)

### State-writes

These change app or saved state but do not touch a device.

- `load_run` - load a run file by path as the primary run
- `load_compare_run` - load a run file by path as a comparison run
- `tags_save` - replace the saved tags for a run
- `dismissed_save` - replace the dismissed suggestions for a run
- `confirm_suggestion` - confirm a suggestion (mints and saves a tag)
- `reject_suggestion` - reject (dismiss) a suggestion
- `rasp_rules_save` - save a RASP rule scope at global or project level
- `rasp_rules_preview` - preview what a candidate RASP rule would match
- `export_findings` - export findings from saved tags to a path (md or json)

### Device actions

Each of these prompts for confirmation in the Anubee Desktop window before it
runs.

- `preflight_capture` - preflight checks for capturing a package
- `start_capture` - start a capture on the device
- `stop_capture` - stop the running capture
- `start_live_libs` - start live native-library watching for a package
- `stop_live_libs` - stop live native-library watching
- `verify_libs` - verify native library load bases in a process
- `dump_lib` - dump a loaded native library from process memory
- `export_lib_artifact` - export a pulled library artifact to a destination path
