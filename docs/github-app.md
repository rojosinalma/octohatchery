# GitHub access

OctoHatchery talks to GitHub in two directions: it calls the REST API (register runners, list repos,
create webhooks, edit workflows) and it receives `workflow_job` webhooks. You choose one of two ways
to authenticate with `GITHUB_AUTH` in `.env`:

| | GitHub App (`GITHUB_AUTH=app`) | Personal access token (`GITHUB_AUTH=pat`) |
|---|---|---|
| Best for | an organisation, or a personal account you want to keep tidy | a quick start on a personal account |
| Webhook | one, on the App, covers every repo it is installed on | one per adopted repo, created on adopt |
| Expiry | the private key does not expire | a fine-grained token lasts at most one year |
| Audit | actions show as the App | actions show as you |

Both modes need `GITHUB_WEBHOOK_SECRET`: a random string (`openssl rand -hex 32`) that GitHub uses to
sign every delivery and OctoHatchery uses to verify it. `/webhooks/github` is the only path that must
be reachable from the internet without login.

## GitHub App mode

### Permissions

Repository permissions:

| Permission | Level | Used for |
|---|---|---|
| Actions | Read and write | list queued jobs and workflow runs; write lets a later version cancel runs |
| Administration | Read and write | create the just-in-time runner registration for each job |
| Contents | Read and write | read workflows; write them when you ask for `apply_runs_on` with `commit` or `pr` |
| Pull requests | Read and write | open the pull request for `apply_runs_on` with `pr` |
| Metadata | Read | required by GitHub for every App |

Subscribe to events: `workflow_job`. Webhook URL: `<PUBLIC_URL>/webhooks/github`.

### Create the App from the manifest

The manifest below (also at [`github-app-manifest.json`](github-app-manifest.json)) carries all of
that. Replace `<PUBLIC_URL>` with the address GitHub can reach, for example `https://octohatchery.example.com`.

```json
{
  "name": "OctoHatchery",
  "url": "https://github.com/rojosinalma/octohatchery",
  "description": "Self-hosted GitHub Actions runners: one ephemeral runner per job.",
  "public": false,
  "default_permissions": {
    "actions": "write",
    "administration": "write",
    "contents": "write",
    "pull_requests": "write",
    "metadata": "read"
  },
  "default_events": ["workflow_job"],
  "hook_attributes": { "url": "<PUBLIC_URL>/webhooks/github", "active": true },
  "redirect_url": "<PUBLIC_URL>/",
  "setup_url": "<PUBLIC_URL>/",
  "setup_on_update": false
}
```

GitHub accepts a manifest through a small HTML form. Save this as `create-app.html`, open it in your
browser and press the button:

```html
<form action="https://github.com/settings/apps/new" method="post">
  <input type="hidden" name="manifest" id="manifest">
  <button type="submit">Create the OctoHatchery App</button>
</form>
<script>
  document.getElementById('manifest').value = JSON.stringify(/* paste the manifest here */);
</script>
```

For an organisation, change the form action to
`https://github.com/organizations/<org>/settings/apps/new`.

After you confirm, GitHub redirects to `<PUBLIC_URL>/?code=...`. **The App does not exist yet at this
point.** The `code` is a one-time ticket, valid for one hour, that you exchange for the App's credentials:

```sh
gh api -X POST /app-manifests/<code>/conversions > app.json
```

The answer carries `id` (→ `GITHUB_APP_ID`), `pem` (→ `GITHUB_APP_PRIVATE_KEY`), `webhook_secret`
(→ `GITHUB_WEBHOOK_SECRET`, GitHub generated it for you) and `html_url`. Only after this call does the
App show up under your developer settings. Then continue at "Install it" below; the private key and
webhook secret steps are already done.

### Or create it by hand

1. Go to **Settings → Developer settings → GitHub Apps → New GitHub App** (for an organisation:
   **Organisation settings → Developer settings → GitHub Apps**).
2. Name: `OctoHatchery` (or anything; names are global). Homepage URL: your `<PUBLIC_URL>`.
3. Webhook: active, URL `<PUBLIC_URL>/webhooks/github`, secret = your `GITHUB_WEBHOOK_SECRET`.
4. Repository permissions: Actions, Administration, Contents, Pull requests → Read and write; Metadata → Read.
5. Subscribe to events: **Workflow job**.
6. Where can this App be installed: **Only on this account**.
7. Create the App.

### Install it and collect the values

(Manifest route: you already have the App ID, key and secret from `app.json`; do steps 3 and 4 only.)

1. On the App's page, note the **App ID** → `GITHUB_APP_ID`.
2. **Private keys → Generate a private key**. GitHub downloads a `.pem` file. Put its content in
   `GITHUB_APP_PRIVATE_KEY`. In `.env` keep it on one line with `\n` for line breaks, or point to a file
   if your deployment prefers that; the value never leaves the node.
3. **Install App** (left menu) → choose your account or organisation → **All repositories** or a
   selection. Repos you leave out cannot be adopted later until you add them here.
4. After the install, the browser URL ends in `/installations/<number>`. That number is
   `GITHUB_APP_INSTALLATION_ID`. You can also list it: `GET /app/installations` with an App JWT
   (for example `bun -e` with `@octokit/app`: `new App({appId, privateKey}).octokit.request('GET /app/installations')`).
5. Set the webhook secret you used → `GITHUB_WEBHOOK_SECRET`.

`.env` for App mode:

```sh
GITHUB_AUTH=app
GITHUB_APP_ID=123456
GITHUB_APP_INSTALLATION_ID=7654321
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=<openssl rand -hex 32>
```

Restart the node. `GET /health` reports GitHub access, and the Repos page lists what the installation
can see. Adopting a repo in App mode only flips a switch in the database: the App's webhook already
covers it.

### User account vs organisation

The steps are the same. The differences:

- The App lives under the account or organisation that created it; the install URL and the
  installation id belong to where you installed it. One App can be installed on both, with a
  different installation id each; OctoHatchery serves one installation per node.
- In an organisation, only owners can create and install Apps. Members may need to request it.
- Organisation runners: OctoHatchery registers runners per repository, so no organisation-level
  runner group is needed. Repos in the organisation must allow repository-level self-hosted runners
  (**Organisation settings → Actions → Runners → Runner creation**).

## Personal access token mode

Use a **fine-grained** token, not a classic one.

1. **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Resource owner: your account (or the organisation, if it allows fine-grained tokens).
3. Repository access: **All repositories**, or pick the ones you will adopt.
4. Repository permissions:

| Permission | Level |
|---|---|
| Actions | Read and write |
| Administration | Read and write |
| Contents | Read and write |
| Pull requests | Read and write |
| Webhooks | Read and write |
| Metadata | Read (set automatically) |

5. Expiry: fine-grained tokens expire after at most one year. Put a reminder in your calendar.
   When the token expires, runners stop registering and `/health` turns red; nothing else breaks.
6. Generate, copy once, and store it:

```sh
GITHUB_AUTH=pat
GITHUB_TOKEN=github_pat_...
GITHUB_WEBHOOK_SECRET=<openssl rand -hex 32>
```

### The per-repo webhook

A token has no App webhook, so OctoHatchery creates one on each repo when you adopt it:

- URL `<PUBLIC_URL>/webhooks/github`, content type JSON, secret `GITHUB_WEBHOOK_SECRET`, event
  `workflow_job`.
- The webhook id is stored with the repo and shown on the Repos page.
- `unadopt_repo` deletes that webhook again. Webhooks OctoHatchery did not create are left alone.
- If the webhook exists already (a previous install, a restore), adopt reuses it.

That is why the token needs **Webhooks: Read and write**.

## Public repositories and pull requests from forks

Self-hosted runners execute whatever the workflow says, on your hardware, inside your network. For a
private repository that is fine: only people with write access can change workflows. For a public
repository, anyone can open a pull request from a fork, and that pull request's workflow runs with
the fork's changes.

Before you adopt a public repo:

1. In the repo (or the organisation): **Settings → Actions → General → Fork pull request workflows
   from outside collaborators** → **Require approval for all outside collaborators**. A maintainer
   then has to approve each run from a new contributor before a runner picks it up.
2. Keep the runner types used by public repos free of secrets and mounts, and give them tight caps.
   `generic` as shipped is fine; `deploy` is not.
3. Prefer `pull_request` over `pull_request_target` in those workflows; the latter runs with the base
   repository's secrets.
4. Consider a separate type and host for public repos, so a bad job cannot slow down your own builds.

GitHub also shows a warning when you add self-hosted runners to a public repo. It is right: treat every
job from a public repo as untrusted code with network access.
