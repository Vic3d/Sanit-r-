// /data/.openclaw/workspace/josh-dashboard/api/pipeline.js
const { Octokit } = require('@octokit/rest');

const OWNER = 'Vicbb-de';
const REPO = 'josh-dashboard';
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
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const { content } = await readStatus();
    return res.status(200).json(content);
  }

  if (req.method === 'POST') {
    const { orderId, status } = req.body;
    const VALID = ['neu','kontaktiert','terminiert','eingeplant','erledigt'];
    if (!orderId || !VALID.includes(status)) {
      return res.status(400).json({ error: 'Invalid orderId or status' });
    }
    const { content, sha } = await readStatus();
    content[orderId] = status;
    await writeStatus(content, sha);
    return res.status(200).json(content);
  }

  res.status(405).json({ error: 'Method not allowed' });
};
