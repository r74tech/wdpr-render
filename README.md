# wdpr-render

Cloudflare Workers API that renders a bulk set of Wikidot pages with WDPR. Missing includes are reported before rendering, and `[[html]]` blocks are stored in R2 and served from a separate signed-URL Worker.

See [docs/api.md](docs/api.md) for the HTTP contract and client workflow.

## Development

```sh
bun install --frozen-lockfile
bun run cf-typegen
```

Create `.dev.vars` without committing it. The same `FILES_URL_SECRET` value is used by both Workers.

```dotenv
FILES_URL_SECRET=<random-secret>
```

Generate the value with `openssl rand -hex 32`. Local values are disposable and are not shared through SOPS.

Run wpv4 on port 5173, the files Worker on 8788, and the API Worker on another port:

```sh
bunx wrangler dev --config wrangler.files.jsonc --port 8788
bunx wrangler dev --config wrangler.jsonc --port 8789
```

Quality checks:

```sh
bun run lint
bun run format
bun run typecheck
bun test
bun run test:workers
```

## Environments

Wrangler named environments do not inherit `vars` or bindings. Each environment therefore declares its own R2 bucket, and staging/production declare their own wpv4 service and Rate Limiting binding.

| Environment | API Worker            | Files Worker                | R2 bucket                  | wpv4 service          |
| ----------- | --------------------- | --------------------------- | -------------------------- | --------------------- |
| development | `wdpr-render-dev`     | `wdpr-render-files-dev`     | `wdpr-render-html-dev`     | HTTP `localhost:5173` |
| staging     | `wdpr-render-staging` | `wdpr-render-files-staging` | `wdpr-render-html-staging` | `wpv4-staging`        |
| production  | `wdpr-render-prd`     | `wdpr-render-files-prd`     | `wdpr-render-html-prd`     | `wpv4-prd`            |

## Cloudflare setup

These commands change Cloudflare account state. Run them only after authenticating the intended account with `wrangler whoami`.

Create the three private buckets:

```sh
bunx wrangler r2 bucket create wdpr-render-html-dev
bunx wrangler r2 bucket create wdpr-render-html-staging
bunx wrangler r2 bucket create wdpr-render-html-prd
```

Apply a seven-day expiration rule to the `html/` prefix in each bucket:

```sh
bunx wrangler r2 bucket lifecycle add wdpr-render-html-dev expire-html-blocks --prefix html/ --expire-days 7
bunx wrangler r2 bucket lifecycle add wdpr-render-html-staging expire-html-blocks --prefix html/ --expire-days 7
bunx wrangler r2 bucket lifecycle add wdpr-render-html-prd expire-html-blocks --prefix html/ --expire-days 7
```

Confirm with `bunx wrangler r2 bucket lifecycle list <bucket>`. Lifecycle deletion may occur after the exact seven-day boundary; signed URLs expire after 24 hours.

### Rate Limiting namespace ledger

`namespace_id` is an account-level counter identity. Reusing one makes bindings share counters. Before the first staging deploy, use a token with Workers Scripts Read and verify both reserved IDs against every deployed Worker:

```sh
CLOUDFLARE_ACCOUNT_ID=<account-id> \
CLOUDFLARE_API_TOKEN=<workers-scripts-read-token> \
bun run check:ratelimit-namespaces
```

The script stops on any listing/settings error. A namespace passes while it is unused before the first deploy, or while exactly one binding owns it at the Worker and binding named in the command. Any other owner or duplicate use exits unsuccessfully. The script never prints the token.

| namespace_id | Binding                          | State                                                |
| ------------ | -------------------------------- | ---------------------------------------------------- |
| `26090201`   | staging `RENDER_RATE_LIMITER`    | reserved locally; account-wide verification required |
| `26090202`   | production `RENDER_RATE_LIMITER` | reserved locally; account-wide verification required |

If either ID has an unexpected owner or duplicate use, choose a new unused ID and replace it in `wrangler.jsonc`, the `check:ratelimit-namespaces` command in `package.json`, and this ledger, then run the check again. Staging and production must remain distinct.

### Secrets

Staging and production use separate `FILES_URL_SECRET` values. Each encrypted file supplies the same value to that environment's files Worker and API Worker:

| Environment | Encrypted file           |
| ----------- | ------------------------ |
| staging     | `secrets/staging.env`    |
| production  | `secrets/production.env` |

Install the pinned SOPS and age versions, then trust the project configuration:

```sh
mise trust
mise install
```

The private age key stays at `~/.config/sops/age/keys.txt`. Edit an encrypted value without creating a plaintext repository file:

```sh
mise run secrets:edit:staging
mise run secrets:edit:production
```

To add or remove an authorized age key, update `.sops.yaml` while an existing key is available, then run `mise run secrets:update-recipients` and commit the rewritten encrypted files.

After the R2 bucket and wpv4 Service Binding target exist, deploy with the encrypted secret:

```sh
mise run secrets:deploy:staging -- --dry-run
mise run secrets:deploy:staging
```

The first command validates both Worker bundles without deploying. The deploy task decrypts to a mode-600 temporary file, deploys the files Worker first and the API Worker second with `wrangler deploy --secrets-file`, then removes the plaintext file. Use `secrets:deploy:production` only after staging verification.

Changing `FILES_URL_SECRET` immediately invalidates URLs signed with the old value and creates a short mismatch while the two Workers deploy sequentially. Keep each environment's value unchanged unless it is compromised.

### Deploy order and Workers Builds

Deploy files before API so the configured `FILES_ORIGIN` is available when API responses begin referring to it:

```sh
bunx wrangler deploy --config wrangler.files.jsonc --env staging
bunx wrangler deploy --config wrangler.jsonc --env staging
```

Repeat with `--env production` only after the staging release gates pass. Configure two Workers Builds projects, one for each Wrangler config. Use `develop` for staging and `production` for production; install with `bun install --frozen-lockfile` and use the matching deploy command above.

The encrypted files are present only in the repository checkout and are not part of either Worker bundle. The current Workers Builds commands do not decrypt SOPS files; Wrangler preserves existing runtime secrets during an ordinary deploy. Run the matching `secrets:deploy:*` task once before the first automatic build and again whenever `FILES_URL_SECRET` changes. Do not add the personal age private key to Workers Builds.

If secret synchronization is automated later, generate a dedicated Workers Builds age key, add only its public recipient to `.sops.yaml`, store its private key as the `SOPS_AGE_KEY` build secret, and use one ordered pipeline to deploy files before API. Two independent builds must not rotate the shared secret concurrently.

Before deploying, verify the target account, R2 lifecycle rules, namespace ledger, required secrets, and the `WPV4` Service Binding. Deployment and resource creation are intentionally not performed by the repository's test suite.
