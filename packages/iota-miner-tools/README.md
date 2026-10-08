# iota-miner-tools

Official IOTA Train at Home Miner ID status query for Node.js and Cloudflare Pages.

## CLI

```bash
npm install
npm run build --workspace=iota-miner-tools
npm exec --workspace=iota-miner-tools -- iota-miner <Miner-ID>
npm exec --workspace=iota-miner-tools -- iota-miner <Miner-ID> --json
```

Node.js 20 or later is required. The CLI reads public Macrocosmos status data only; it does not inspect, start, stop, or restart the local miner application.

## Package

The package exposes the shared official API client and an `iota-miner` executable. Verify the npm package name is available before publishing. No publish is performed by this repository's build or test scripts.

After publication, install globally with `npm install -g iota-miner-tools` and run `iota-miner <Miner-ID>`.
