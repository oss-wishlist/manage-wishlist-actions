The repository: manage-wishlist-actions

## Purpose
This GitHub Action automates FUNDING.yml management for wishlist projects in the Open Source Wishlist system.

## What this action does (detailed workflow)
1. **Triggers**: Runs via `repository_dispatch` webhook when a wishlist is approved in the database (`approved = true` AND `funding_yml = true`)
2. **Fetch wishlist data**: Query PostgreSQL database:
   - Connect using `DATABASE_URL` secret
   - Query: `SELECT id, repository_url, maintainer_username, funding_yml, approved FROM wishlists WHERE id = $1 AND approved = true`
   - Extract: maintainer username, project repository URL, wishlist ID
   - Construct fulfill URL: `https://oss-wishlist.com/oss-wishlist-website/fullfill?issue={id}`
3. **Check FUNDING.yml**: Look for existing `FUNDING.yml` in target repo (check `.github/FUNDING.yml` first, then root `FUNDING.yml`)
4. **Create or update PR**:
   - **If no FUNDING.yml exists**: Create new file with `custom: ['<FULFILL_URL>']`
   - **If FUNDING.yml exists**: Remove old wishlist URLs and add only the current fulfill URL
   - PR title: `Add wishlist link to FUNDING.yml`
   - PR body template:
     ```
     This PR was opened at the request of @<maintainer> to add a wishlist link to your repository's sponsor button.
     
     Wishlist issue: <FULFILL_URL>
     
     This will display the wishlist link in the "Sponsor this project" section of your repository.
     
     For more information about FUNDING.yml, see: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/displaying-a-sponsor-button-in-your-repository
     ```
5. **Idempotency**: Only create one PR per wishlist:
   - Use deterministic branch name: `add-wishlist-funding-{id}`
   - Reuse branch and PR if they already exist
   - No label/comment tracking needed (database is source of truth)

## Key constraints and patterns
- **Only process approved wishlists**: Query filters `WHERE approved = true AND funding_yml = true`
- **Performance**: Check `.github/FUNDING.yml` via API first (most common location), fall back to root only if 404
- **Idempotency**: Use deterministic branch names (`add-wishlist-funding-{id}`), reuse existing branches/PRs
- **Error handling**: If ANY errors occur (DB connection, missing data, target repo doesn't exist, PR creation fails, etc.), fail the action and log details

## Implementation guidance for AI agents

### File structure
- `action.yml` — Action metadata with inputs (github-token, database-url, wishlist-id, cache-url) and outputs (pr-url, status)
- `src/index.js` — Main logic (Node.js with pg for PostgreSQL, Octokit for GitHub API)
- `.github/workflows/*.yml` — Example workflows for repository_dispatch and workflow_dispatch triggers
- `README.md` — Usage docs, database setup, webhook integration
- `.env.example` — Template for DATABASE_URL and secrets

### Implementation strategy
1. **Fetch wishlist from database**:
   - Use `pg` (PostgreSQL client) to connect with `DATABASE_URL`
   - Query: `SELECT id, repository_url, maintainer_username, funding_yml, approved FROM wishlists WHERE id = $1 AND approved = true`
   - Validate: wishlist exists, is approved, has `funding_yml = true`
   - Extract: maintainer username, repo URL, wishlist ID
   - Construct fulfill URL: `https://oss-wishlist.com/oss-wishlist-website/fullfill?issue={id}`
2. **GitHub API calls**:
   - `GET /repos/{owner}/{repo}/contents/.github/FUNDING.yml` (check primary location)
   - `GET /repos/{owner}/{repo}/contents/FUNDING.yml` (fallback if 404)
   - `POST /repos/{owner}/{repo}/forks` (create fork if needed)
   - `POST /repos/{owner}/{repo}/git/refs` (create branch in fork)
   - `PUT /repos/{owner}/{repo}/contents/{path}` (create/update FUNDING.yml in fork)
   - `POST /repos/{owner}/{repo}/pulls` (create PR from fork to upstream)
3. **FUNDING.yml updates**: 
   - Parse existing file with `js-yaml`
   - Remove any old wishlist URLs (GitHub issue URLs or old fulfill URLs)
   - Add only the current fulfill URL
   - Write back as YAML
4. **Idempotency**: 
   - Use deterministic branch name: `add-wishlist-funding-{id}`
   - Check if branch exists; reuse if found
   - Check if PR exists for that branch; return existing PR URL if found

### Code patterns
- Use `@actions/core`, `@actions/github`, `@octokit/rest` for GitHub API
- Use `pg` (node-postgres) for PostgreSQL database queries
- Use `js-yaml` for YAML parsing/dumping
- Environment variables: `GITHUB_TOKEN`, `DATABASE_URL`
- Error handling: Log errors and fail the action (no auto-issue creation)
- Example FUNDING.yml format:
  ```yaml
  custom: ['https://oss-wishlist.com/oss-wishlist-website/fullfill?issue=123']
  ```
- Remove old URLs: filter out any GitHub issue URLs or old fulfill URLs before adding current one

### Testing and debugging
- Test locally with `.env` file containing `DATABASE_URL` and `GITHUB_TOKEN`
- Manual trigger: Use `workflow_dispatch` in GitHub Actions UI with a wishlist ID
- Webhook trigger: Send `repository_dispatch` event with `wishlist_id` in client_payload
- Check action logs for database connection, query results, and PR creation steps

### References
- Database schema: wishlists table with id, repository_url, maintainer_username, funding_yml, approved fields
- FUNDING.yml spec: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/displaying-a-sponsor-button-in-your-repository
- Octokit REST API: https://octokit.github.io/rest.js/
- node-postgres docs: https://node-postgres.com/