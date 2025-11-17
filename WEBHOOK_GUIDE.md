# Triggering the Action from Your App

When a wishlist is approved in your database (set `approved = true`), your app should send a webhook to GitHub to trigger the workflow.

## Example: Trigger via repository_dispatch

```javascript
// Example Node.js code to trigger the workflow from your app
const fetch = require('node-fetch');

async function triggerFundingYmlPR(wishlistId) {
  const response = await fetch(
    'https://api.github.com/repos/oss-wishlist/wishlists/dispatches',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        event_type: 'wishlist-approved',
        client_payload: {
          wishlist_id: wishlistId
        }
      })
    }
  );
  
  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }
  
  console.log(`Triggered FUNDING.yml PR creation for wishlist ${wishlistId}`);
}

// Call this when a wishlist is approved
triggerFundingYmlPR(123);
```

## Environment Variables

Your app needs a GitHub token with `repo` scope (or `public_repo` for public repos only) to send repository_dispatch events.

Store it as `GITHUB_TOKEN` in your app's environment.

## Manual Testing

You can also trigger the workflow manually from the GitHub Actions UI:
1. Go to https://github.com/oss-wishlist/wishlists/actions
2. Select "Manage Wishlist Actions" workflow
3. Click "Run workflow"
4. Enter a wishlist ID
5. Click "Run workflow"
