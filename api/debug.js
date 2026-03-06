module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const hasUrl = !!process.env.KV_REST_API_URL;
  const hasToken = !!process.env.KV_REST_API_TOKEN;
  
  let kvTest = null;
  let kvError = null;
  if (hasUrl && hasToken) {
    try {
      const { kv } = require('@vercel/kv');
      await kv.set('test:ping', 'pong', { ex: 60 });
      kvTest = await kv.get('test:ping');
    } catch (e) {
      kvError = e.message;
    }
  }
  
  res.json({
    env: {
      KV_REST_API_URL: hasUrl ? process.env.KV_REST_API_URL.substring(0, 40) + '...' : null,
      KV_REST_API_TOKEN: hasToken ? '***set***' : null,
    },
    kvTest,
    kvError,
  });
};
