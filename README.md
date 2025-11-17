# manage-wishlist-actions

GitHub Action that manages wishlist-related automation for projects in the [Open Source Wishlist](https://oss-wishlist.com).

## What it does

When a wishlist is approved in the database (triggered via webhook or manual dispatch), this action:

1. **Fetches wishlist data** from PostgreSQL database (maintainer, project repository, wishlist ID)
2. **Checks for existing FUNDING.yml** (in `.github/` or root) and existing PRs
3. **Creates a pull request** to add or update the FUNDING.yml with the wishlist link
4. **Refreshes the wishlist cache** so the JSON feed is up-to-date
5. **Handles duplicates** by reusing existing branches and PRs when possible

## Architecture

- **Database**: PostgreSQL on Digital Ocean stores wishlist data
- **Trigger**: Webhook (`repository_dispatch`) sent by your app when `approved = true` and `funding_yml = true`
- **Action**: Queries DB, forks target repo, creates/updates FUNDING.yml, opens PR

## Usage

### Prerequisites

1. **Database**: PostgreSQL connection string for the wishlists database
2. **GitHub Token**: Personal Access Token (PAT) with `public_repo` scope

#### Database Setup

The action queries this PostgreSQL schema:
```sql
CREATE TABLE wishlists (
  id INTEGER PRIMARY KEY,
  repository_url TEXT NOT NULL,
  maintainer_username VARCHAR(255) NOT NULL,
  funding_yml BOOLEAN DEFAULT FALSE,
  approved BOOLEAN DEFAULT FALSE,
  ...
);
```

Only wishlists where `approved = true` AND `funding_yml = true` will be processed.

#### Bot Account Setup

For professional PRs from a bot account (e.g., `@oss-wishlist-bot`):

1. **Create a new GitHub account**
   - Sign up at https://github.com/signup
   - Username suggestion: `oss-wishlist-bot`
   - Use an email like `bot@your-org.com` or create a free email account

2. **Add bot to organization** (optional but recommended)
   - Go to https://github.com/orgs/oss-wishlist/people
   - Invite `oss-wishlist-bot` as a member
   - No special permissions needed - regular member is fine

3. **Add bot as collaborator to wishlists repo** (required)
   - Go to https://github.com/oss-wishlist/wishlists/settings/access
   - Click **Add people**
   - Search for `oss-wishlist-bot`
   - Select **Write** role (needed to add labels and comments)
   - Send invitation and accept it from the bot account

4. **Create a Personal Access Token from the bot account**
   - Log in as the bot account
   - Go to **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)**
   - Click **Generate new token (classic)**
   - Name: `Wishlist FUNDING.yml Manager`
   - Scopes: Check **public_repo** (or full **repo** if you need private repo support)
   - Click **Generate token** and copy it immediately

5. **Add token to wishlists repository secrets**
   - In the `oss-wishlist/wishlists` repository, go to **Settings** → **Secrets and variables** → **Actions**
   - Click **New repository secret**
   - Name: `WISHLIST_BOT_TOKEN`
   - Value: Paste the token from step 3
   - Click **Add secret**

5. **Add secrets to the repository**
   - In the repository where the workflow runs (e.g., `oss-wishlist/wishlists`), go to **Settings** → **Secrets and variables** → **Actions**
   - Add `WISHLIST_BOT_TOKEN`: the PAT from step 4
   - Add `DATABASE_URL`: your PostgreSQL connection string (e.g., `postgresql://user:pass@host:port/db`)

### Workflow Setup

Add this workflow to `.github/workflows/manage-wishlist-actions.yml` in your repository:

```yaml
name: Manage Wishlist Actions

on:
  # Triggered by your app via webhook when a wishlist is approved
  repository_dispatch:
    types: [wishlist-approved]
  
  # Manual trigger for testing
  workflow_dispatch:
    inputs:
      wishlist_id:
        description: 'Wishlist ID to process'
        required: true
        type: number

jobs:
  manage-wishlist:
    runs-on: ubuntu-latest
    
    permissions:
      contents: read
      
    steps:
      - name: Manage Wishlist Actions
        uses: oss-wishlist/manage-wishlist-actions@v2
        with:
          github-token: ${{ secrets.WISHLIST_BOT_TOKEN }}
          database-url: ${{ secrets.DATABASE_URL }}
          wishlist-id: ${{ github.event.client_payload.wishlist_id || github.event.inputs.wishlist_id }}
```

### Triggering from Your App

When a wishlist is approved in your database, send a webhook to GitHub:

```javascript
fetch('https://api.github.com/repos/oss-wishlist/wishlists/dispatches', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    event_type: 'wishlist-approved',
    client_payload: { wishlist_id: 123 }
  })
});
```

See [WEBHOOK_GUIDE.md](./WEBHOOK_GUIDE.md) for complete examples.### Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `github-token` | Personal Access Token with `public_repo` scope | Yes | N/A |
| `database-url` | PostgreSQL connection string | Yes | N/A |
| `wishlist-id` | Wishlist ID to process (from webhook or manual input) | Yes | N/A |
| `cache-url` | URL to refresh wishlist cache | No | (staging URL) |

### Outputs

| Output | Description |
|--------|-------------|
| `pr-url` | URL of the created pull request |
| `status` | Status of the action (`success`, `skipped`, or `error`) |

## Development

### Versioning and pinning

- Recommended: pin to the major tag to receive compatible fixes automatically:
   - `uses: oss-wishlist/manage-wishlist-actions@v1`
- Pin to an exact release for immutability:
   - `uses: oss-wishlist/manage-wishlist-actions@v1.1.0`

When a new release is cut, the moving `v1` tag will be updated to point at the latest v1.x.x.

### Setup

```bash
npm install
```

### Build

The action needs to be compiled before use:

```bash
npm run build
```

This creates `dist/index.js` which is committed to the repository.

### Testing locally

You can test the action locally using [act](https://github.com/nektos/act):

```bash
act issues -e test-event.json
```

## How it works

### Data fetching

The action connects to PostgreSQL and queries:
```sql
SELECT id, repository_url, maintainer_username, funding_yml, approved
FROM wishlists
WHERE id = $1 AND approved = true
LIMIT 1
```

It verifies:
- Wishlist exists and is approved
- `funding_yml = true` (maintainer requested FUNDING.yml PR)

Then constructs the fulfill URL: `https://oss-wishlist.com/oss-wishlist-website/fullfill?issue={id}`

### Fork-based PR workflow

Since the bot account doesn't have write access to target repositories, the action uses a fork-based workflow:

1. **Fork the repository** (or use existing fork)
2. **Create a branch** in the fork
3. **Commit changes** to FUNDING.yml in the fork
4. **Create a PR** from the fork to the upstream repository

This is the standard open-source contribution workflow and doesn't require the bot to be a collaborator on target repos.

### Idempotency

The action prevents duplicates by:
- Using deterministic branch names per wishlist ID: `add-wishlist-funding-{id}`
- Reusing existing branches and PRs if they already exist
- Checking if the wishlist URL is already in FUNDING.yml before creating a PR
- Removing old wishlist URLs when updating (only keeps the current one)

No label or comment tracking is needed since the database is the source of truth.

### Error handling

If any errors occur (parsing failures, API errors, etc.), the action creates an issue in this repository with full error details for investigation.

## License

MIT
