// /data/.openclaw/workspace/josh-dashboard/api/pipeline.js
const { Octokit } = require('@octokit/rest');

// TRA-202: Fixed repo owner and name
const OWNER = 'Vic3d';
const REPO = 'Sanit-r-';
const FILE_PATH = 'data/pipeline-status.json';

async function readStatus() {
  try {
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: FILE_PATH });
    return {
      content: JSON.parse(Buffer.from(data.content, 'base64').toString()),
      sha: data.sha
    };
  } catch (e) {
    return { content: {}, sha: null };
  }
}

async function writeStatus(content, sha) {
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  await octokit.repos.createOrUpdateFileContents({
    owner: OWNER, repo: REPO, path: FILE_PATH,
    message: 'Pipeline status update',
    content: Buffer.from(JSON.stringify(content, null, 2)).toString('base64'),
    sha: sha || undefined
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // TRA-202: Return graceful error if GITHUB_TOKEN not configured
  if (!process.env.GITHUB_TOKEN) {
    return res.status(200).json({ columns: [], error: 'GITHUB_TOKEN not configured' });
  }

  if (req.method === 'GET') {
    try {
      const { content } = await readStatus();
      return res.status(200).json(content);
    } catch (e) {
      return res.status(200).json({ columns: [], error: e.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const { orderId, status } = req.body;
      const VALID = ['neu','kontaktiert','terminiert','eingeplant','erledigt'];
      if (!orderId || !VALID.includes(status)) {
        return res.status(400).json({ error: 'Invalid orderId or status' });
      }
      const { content, sha } = await readStatus();
      content[orderId] = status;
      await writeStatus(content, sha);
      return res.status(200).json(content);
    } catch (e) {
      return res.status(200).json({ columns: [], error: e.message });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
};
