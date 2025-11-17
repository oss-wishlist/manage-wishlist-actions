const core = require('@actions/core');
const github = require('@actions/github');
const yaml = require('js-yaml');
const { Client } = require('pg');

/**
 * Fetch wishlist data from PostgreSQL database
 * @param {string} databaseUrl - PostgreSQL connection string
 * @param {number} wishlistId - Wishlist ID (GitHub issue number)
 * @returns {object} Wishlist data with maintainer, repository, and wishlistUrl
 */
async function fetchWishlistFromDatabase(databaseUrl, wishlistId) {
  const client = new Client({ connectionString: databaseUrl });
  
  try {
    await client.connect();
    core.info(`Connected to database, fetching wishlist ID: ${wishlistId}`);
    
    const query = `
      SELECT 
        id,
        repository_url,
        maintainer_username,
        funding_yml,
        approved
      FROM wishlists
      WHERE id = $1 AND approved = true
      LIMIT 1
    `;
    
    const result = await client.query(query, [wishlistId]);
    
    if (result.rows.length === 0) {
      throw new Error(`Wishlist ID ${wishlistId} not found or not approved in database`);
    }
    
    const wishlist = result.rows[0];
    
    // Ensure funding_yml is requested
    if (!wishlist.funding_yml) {
      throw new Error(`Wishlist ID ${wishlistId} does not have funding_yml=true`);
    }
    
    core.info(`Found wishlist: maintainer=${wishlist.maintainer_username}, repo=${wishlist.repository_url}`);
    
    // Construct the wishlist fulfill URL
    const wishlistUrl = `https://oss-wishlist.com/oss-wishlist-website/fullfill?issue=${wishlist.id}`;
    
    return {
      maintainer: wishlist.maintainer_username,
      repository: wishlist.repository_url,
      wishlistUrl
    };
  } finally {
    await client.end();
  }
}

/**
 * Parse owner and repo from a GitHub URL
 * @param {string} repoUrl - GitHub repository URL
 * @returns {object} Owner and repo name
 */
function parseRepoUrl(repoUrl) {
  const match = repoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) {
    throw new Error(`Invalid GitHub repository URL: ${repoUrl}`);
  }
  return { owner: match[1], repo: match[2] };
}

/**
 * Check if FUNDING.yml exists in the target repository
 * @param {object} octokit - GitHub API client
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {object} File info or null if not found
 */
async function checkFundingFile(octokit, owner, repo) {
  // Check .github/FUNDING.yml first (most common)
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: '.github/FUNDING.yml'
    });
    core.info('Found existing FUNDING.yml in .github/');
    return { path: '.github/FUNDING.yml', sha: data.sha, content: data.content };
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  
  // Check root FUNDING.yml as fallback
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: 'FUNDING.yml'
    });
    core.info('Found existing FUNDING.yml in root');
    return { path: 'FUNDING.yml', sha: data.sha, content: data.content };
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  
  core.info('No existing FUNDING.yml found');
  return null;
}

/**
 * Create or update FUNDING.yml content
 * @param {string|null} existingContent - Base64 encoded existing content or null
 * @param {string} wishlistUrl - Wishlist URL to add
 * @returns {string} New FUNDING.yml content
 */
function createFundingContent(existingContent, wishlistUrl) {
  if (!existingContent) {
    // Create new FUNDING.yml
    return `custom: ['${wishlistUrl}']\n`;
  }
  
  // Parse existing FUNDING.yml
  const decoded = Buffer.from(existingContent, 'base64').toString('utf-8');
  const fundingData = yaml.load(decoded) || {};
  
  // Add or append to custom array
  if (!fundingData.custom) {
    fundingData.custom = [];
  } else if (!Array.isArray(fundingData.custom)) {
    fundingData.custom = [fundingData.custom];
  }

  // Remove any old GitHub issue URLs and old fulfill URLs, keeping only the current wishlist URL
  const issueUrlRegex = /https:\/\/github\.com\/oss-wishlist\/wishlists\/issues\/\d+/;
  const oldFulfillRegex = /https:\/\/oss-wishlist\.com\/(oss-wishlist\/)?fullfill?\?issue=\d+/;
  
  fundingData.custom = fundingData.custom.filter((entry) => {
    if (typeof entry === 'string') {
      // Remove old GitHub issue URLs
      if (issueUrlRegex.test(entry)) {
        core.info(`Removing old GitHub issue URL: ${entry}`);
        return false;
      }
      // Remove old fulfill URLs (different format or different issue number)
      if (oldFulfillRegex.test(entry) && entry !== wishlistUrl) {
        core.info(`Removing old fulfill URL: ${entry}`);
        return false;
      }
    }
    return true;
  });
  
  // Add wishlist URL if not already present
  if (!fundingData.custom.includes(wishlistUrl)) {
    fundingData.custom.push(wishlistUrl);
    core.info(`Added wishlist URL: ${wishlistUrl}`);
  }
  
  return yaml.dump(fundingData);
}

/**
 * Check if there's already an open or closed PR from the bot for this wishlist URL
 * @param {object} octokit - GitHub API client
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} botUsername - Bot's username
 * @param {string} wishlistUrl - The wishlist URL to check for
 * @returns {object|null} Existing PR or null
 */
async function checkExistingPR(octokit, owner, repo, botUsername, wishlistUrl) {
  try {
    // Check both open and closed PRs
    const states = ['open', 'closed'];
    
    for (const state of states) {
      const { data: prs } = await octokit.rest.pulls.list({
        owner,
        repo,
        state,
        per_page: 100
      });
      
      // Look for PRs from the bot with FUNDING.yml in the title
      const botPRs = prs.filter(pr => 
        pr.user.login === botUsername && 
        pr.title.includes('FUNDING.yml')
      );
      
      // Check if any of these PRs contain the same wishlist URL in the body
      for (const pr of botPRs) {
        if (pr.body && pr.body.includes(wishlistUrl)) {
          core.info(`Found existing ${state} PR from bot with same wishlist URL: ${pr.html_url}`);
          return pr;
        }
      }
    }
    
    return null;
  } catch (error) {
    core.warning(`Failed to check for existing PRs: ${error.message}`);
    return null;
  }
}

/**
 * Create a pull request to add/update FUNDING.yml
 * @param {object} octokit - GitHub API client
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {object} data - Parsed issue data
 * @param {object|null} fundingFile - Existing FUNDING.yml info
 * @returns {string} PR URL
 */
async function createPullRequest(octokit, owner, repo, data, fundingFile, issueNumber) {
  // Use a deterministic branch name per wishlist issue to avoid parallel-run duplication
  const branchName = `add-wishlist-funding-${issueNumber}`;
  const filePath = fundingFile ? fundingFile.path : '.github/FUNDING.yml';
  
  // Get authenticated user info
  const { data: authenticatedUser } = await octokit.rest.users.getAuthenticated();
  const forkOwner = authenticatedUser.login;
  
  core.info(`Authenticated as: ${forkOwner}`);
  
  // Check for existing PRs from this bot for the same wishlist URL
  const existingPR = await checkExistingPR(octokit, owner, repo, forkOwner, data.wishlistUrl);
  if (existingPR) {
    core.info(`Existing PR found for this wishlist (${existingPR.state}): ${existingPR.html_url}`);
    return existingPR.html_url;
  }
  
  // Get default branch
  const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
  const defaultBranch = repoData.default_branch;
  
  // Check if we already have a fork, if not create one
  let forkRepo;
  try {
    const { data: existingFork } = await octokit.rest.repos.get({
      owner: forkOwner,
      repo: repo
    });
    forkRepo = existingFork;
    core.info(`Found existing fork: ${forkOwner}/${repo}`);
  } catch (error) {
    if (error.status === 404) {
      // Create fork
      core.info(`Creating fork of ${owner}/${repo}...`);
      const { data: newFork } = await octokit.rest.repos.createFork({
        owner,
        repo
      });
      forkRepo = newFork;
      
      // Wait a bit for fork to be ready
      core.info('Waiting for fork to be ready...');
      await new Promise(resolve => setTimeout(resolve, 5000));
    } else {
      throw error;
    }
  }
  
  // Get the SHA of the default branch from the fork
  const { data: refData } = await octokit.rest.git.getRef({
    owner: forkOwner,
    repo: repo,
    ref: `heads/${defaultBranch}`
  });
  const baseSha = refData.object.sha;
  
  // Create new branch in fork (or reuse if it already exists)
  try {
    await octokit.rest.git.createRef({
      owner: forkOwner,
      repo: repo,
      ref: `refs/heads/${branchName}`,
      sha: baseSha
    });
    core.info(`Created branch ${branchName} in fork`);
  } catch (err) {
    if (err.status === 422) {
      core.info(`Branch ${branchName} already exists in fork. Reusing.`);
    } else {
      throw err;
    }
  }
  
  // Re-fetch FUNDING.yml from the fork to get the latest SHA (in case it changed)
  let latestFundingFile = null;
  if (fundingFile) {
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner: forkOwner,
        repo: repo,
        path: filePath,
        ref: branchName
      });
      latestFundingFile = { path: filePath, sha: data.sha, content: data.content };
      core.info(`Re-fetched ${filePath} from fork branch to get latest SHA`);
    } catch (err) {
      if (err.status === 404) {
        core.info(`${filePath} not found in fork branch; will create it`);
      } else {
        throw err;
      }
    }
  }
  
  // Create or update FUNDING.yml in fork
  const newContent = createFundingContent(
    latestFundingFile ? latestFundingFile.content : (fundingFile ? fundingFile.content : null),
    data.wishlistUrl
  );
  
  await octokit.rest.repos.createOrUpdateFileContents({
    owner: forkOwner,
    repo: repo,
    path: filePath,
    message: fundingFile ? 'Update FUNDING.yml with wishlist link' : 'Add FUNDING.yml with wishlist link',
    content: Buffer.from(newContent).toString('base64'),
    branch: branchName,
    sha: latestFundingFile ? latestFundingFile.sha : undefined
  });
  
  core.info(`Created/updated ${filePath} in fork`);
  
  // Create pull request from fork to upstream
  const prBody = `This PR was opened at the request of @${data.maintainer} to add a wishlist link to your repository's sponsor button.

Wishlist issue: ${data.wishlistUrl}

This will display the wishlist link in the "Sponsor this project" section of your repository to help wishlist sponsors find, and fulfill wishes that help this project.

For more information:
- Open Source Wishlist: https://oss-wishlist.com
- FUNDING.yml settings: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/displaying-a-sponsor-button-in-your-repository`;

  try {
    const { data: pr } = await octokit.rest.pulls.create({
      owner,
      repo,
      title: 'Add wishlist link to FUNDING.yml',
      head: `${forkOwner}:${branchName}`,
      base: defaultBranch,
      body: prBody
    });
    core.info(`Created PR: ${pr.html_url}`);
    return pr.html_url;
  } catch (err) {
    // If a PR already exists for this branch, surface that PR instead of failing
    if (err.status === 422) {
      core.info('PR might already exist for this branch. Looking it up...');
      const { data: existingPRs } = await octokit.rest.pulls.list({ owner, repo, state: 'open', head: `${forkOwner}:${branchName}` });
      if (existingPRs && existingPRs.length > 0) {
        core.info(`Found existing PR: ${existingPRs[0].html_url}`);
        return existingPRs[0].html_url;
      }
      // Fallback: check any PRs (open/closed) containing the wishlist URL
      const maybeExisting = await checkExistingPR(octokit, owner, repo, forkOwner, data.wishlistUrl);
      if (maybeExisting) return maybeExisting.html_url;
    }
    throw err;
  }
}

/**
 * Check if issue has already been processed
 * @param {object} octokit - GitHub API client
 * @param {number} issueNumber - Issue number
 * @returns {boolean} True if already processed
 */
async function isAlreadyProcessed(octokit, issueNumber) {
  const { data: issue } = await octokit.rest.issues.get({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: issueNumber
  });
  
  // Check for label
  if (issue.labels.some(label => label.name === 'funding-yml-processed')) {
    core.info('Issue already has funding-yml-processed label');
    return true;
  }
  
  // Check for comment marker
  const { data: comments } = await octokit.rest.issues.listComments({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: issueNumber
  });
  
  if (comments.some(comment => comment.body.includes('<!-- funding-yml-pr:'))) {
    core.info('Issue already has funding-yml-pr comment marker');
    return true;
  }
  
  return false;
}

/**
 * Mark issue as processed
 * @param {object} octokit - GitHub API client
 * @param {number} issueNumber - Issue number
 * @param {string} prUrl - Pull request URL
 */
async function markAsProcessed(octokit, issueNumber, prUrl) {
  // Add comment marker
  await octokit.rest.issues.createComment({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: issueNumber,
    body: `<!-- funding-yml-pr: ${prUrl} -->\n\n✅ Created PR to add FUNDING.yml: ${prUrl}`
  });
  
  // Add label
  await octokit.rest.issues.addLabels({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: issueNumber,
    labels: ['funding-yml-processed']
  });
  
  core.info('Marked issue as processed');
}

/**
 * Report error by creating an issue in this repo
 * @param {object} octokit - GitHub API client
 * @param {number} issueNumber - Original issue number
 * @param {Error} error - The error that occurred
 */
async function reportError(octokit, issueNumber, error) {
  const issueUrl = `https://github.com/${github.context.repo.owner}/${github.context.repo.repo}/issues/${issueNumber}`;
  
  const errorBody = `**Error processing wishlist issue**

**Original Issue:** ${issueUrl}

**Error Message:**
\`\`\`
${error.message}
\`\`\`

**Stack Trace:**
\`\`\`
${error.stack}
\`\`\`

**Context:**
- Issue Number: #${issueNumber}
- Repository: ${github.context.repo.owner}/${github.context.repo.repo}
- Timestamp: ${new Date().toISOString()}
`;
  
  await octokit.rest.issues.create({
    owner: 'oss-wishlist',
    repo: 'manage-wishlist-actions',
    title: `Error processing wishlist issue #${issueNumber}`,
    body: errorBody,
    labels: ['error', 'automated']
  });
  
  core.error(`Reported error to manage-wishlist-actions repo`);
}

/**
 * Main action logic
 */
async function run() {
  try {
    const token = core.getInput('github-token', { required: true });
    const databaseUrl = core.getInput('database-url', { required: true });
    const wishlistId = parseInt(core.getInput('wishlist-id', { required: true }), 10);
    const cacheUrl = core.getInput('cache-url', { required: false }) || 'https://urchin-app-bozjb.ondigitalocean.app/api/wishlists?refresh=true';
    const octokit = github.getOctokit(token);
    
    if (!wishlistId || isNaN(wishlistId)) {
      core.setFailed('Invalid wishlist-id provided');
      return;
    }
    
    core.info(`Processing wishlist ID: ${wishlistId}`);
    
    // Fetch wishlist data from database
    const data = await fetchWishlistFromDatabase(databaseUrl, wishlistId);
    core.info(`Parsed data: Maintainer=${data.maintainer}, Repo=${data.repository}`);
  core.info(`Wishlist URL to add: ${data.wishlistUrl}`);
    
    // Parse target repository
    const { owner, repo } = parseRepoUrl(data.repository);
    core.info(`Target repository: ${owner}/${repo}`);
    
    // Check for existing FUNDING.yml
    const fundingFile = await checkFundingFile(octokit, owner, repo);
    
    // Check if wishlist URL is already in FUNDING.yml
    if (fundingFile) {
      const decoded = Buffer.from(fundingFile.content, 'base64').toString('utf-8');
      const fundingData = yaml.load(decoded) || {};
      
      if (fundingData.custom) {
        const customArray = Array.isArray(fundingData.custom) ? fundingData.custom : [fundingData.custom];
        if (customArray.includes(data.wishlistUrl)) {
          core.info('Wishlist URL already exists in FUNDING.yml. Skipping PR creation.');
          core.setOutput('status', 'skipped');
          core.setOutput('pr-url', `${data.repository} (already has wishlist link)`);
          return;
        }
      }
    }
    
    // Create pull request
    const prUrl = await createPullRequest(octokit, owner, repo, data, fundingFile, wishlistId);
    
    // Refresh wishlist cache
    try {
      core.info('Refreshing wishlist cache...');
      const response = await fetch(cacheUrl);
      if (response.ok) {
        core.info('✅ Wishlist cache refreshed successfully');
      } else {
        core.warning(`Failed to refresh cache: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      core.warning(`Failed to refresh wishlist cache: ${error.message}`);
    }
    
    core.setOutput('pr-url', prUrl);
    core.setOutput('status', 'success');
    
    core.info('✅ Action completed successfully');
  } catch (error) {
    core.error(`Action failed: ${error.message}`);
    core.error(error.stack);
    
  // Report error to manage-wishlist-actions repo
    try {
      const token = core.getInput('github-token', { required: true });
      const octokit = github.getOctokit(token);
      const issue = github.context.payload.issue;
      
      if (issue) {
        await reportError(octokit, issue.number, error);
      }
    } catch (reportingError) {
      core.error(`Failed to report error: ${reportingError.message}`);
    }
    
    core.setFailed(error.message);
    core.setOutput('status', 'error');
  }
}

run();
