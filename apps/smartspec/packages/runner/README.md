# @smartspec/runner

Runs a SmartSpec schematic's contract checks against its implementation. It fetches the code (a
Docker image, a Compose service, a git repository or an archive, or something already running),
starts it, waits until it's ready, runs each check over HTTP, and stops it. It has no dependencies.

```sh
smartspec-runner run job.json     # or: … run - < job.json
```

A job is made by whatever holds the schematic (the SmartSpec app), so the runner needs nothing else:

```json
{
  "version": 1,
  "id": "orders-3f2a",
  "implementation": { "source": { "kind": "git", "url": "https://github.com/larder/orders.git" },
                      "start": { "port": 3000, "commands": ["npm ci", "npm start"] },
                      "ready": { "path": "/health" } },
  "workdir": "/Users/me/code/orders",
  "shapes": { "Order": { "type": "object", "required": ["id"] } },
  "checks": [{ "key": "read/same", "setup": [], "request": { "method": "GET", "path": "/orders/1" },
               "expect": { "status": 200, "shape": "Order" } }]
}
```

`workdir` is optional. It names a folder on this machine that stands in for the repository or archive.

What happens is written as JSON lines: `job`, `phase` (fetch, start, ready, check, stop), `log`,
`result` (each check's `key`, `outcome` passed, failed or error, and `detail`), then `done`. It exits 0
when every check passed, 1 when one failed, and 2 when they couldn't all be run.

Logins come from the machine it runs on: git's credential helper, and Docker's login.
