// Vercel serverless function: /api/scan-card
// Receives a base64 photo from the browser, sends it to LlamaParse for OCR,
// polls until the parse job finishes, and returns the extracted text.
//
// Required env var (set in Vercel dashboard, never in code):
//   LLAMA_CLOUD_API_KEY = your key from https://cloud.llamaindex.ai

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } }
};

const BASE_URL = 'https://api.cloud.llamaindex.ai/api/v2';
const POLL_INTERVAL_MS = 1500;
const MAX_POLLS = 20; // ~30s worst case

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.LLAMA_CLOUD_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server missing LLAMA_CLOUD_API_KEY' });
    return;
  }

  const { imageBase64, mimeType } = req.body || {};
  if (!imageBase64) {
    res.status(400).json({ error: 'No image provided' });
    return;
  }

  try {
    const buffer = Buffer.from(imageBase64, 'base64');
    const blob = new Blob([buffer], { type: mimeType || 'image/jpeg' });

    const form = new FormData();
    form.append('file', blob, 'card.jpg');
    form.append('tier', 'fast');       // cheapest/fastest tier; good fit for single-card photos
    form.append('version', 'latest');

    const uploadResp = await fetch(`${BASE_URL}/parse/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });

    if (!uploadResp.ok) {
      const detail = await uploadResp.text();
      res.status(502).json({ error: 'LlamaParse upload failed', detail });
      return;
    }

    const uploadData = await uploadResp.json();
    const jobId = uploadData.id || (uploadData.job && uploadData.job.id);
    if (!jobId) {
      res.status(502).json({ error: 'No job id returned from LlamaParse' });
      return;
    }

    let text = '';
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

      const pollResp = await fetch(`${BASE_URL}/parse/${jobId}?expand=text_full`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      const pollData = await pollResp.json();
      const status = pollData.job && pollData.job.status;

      if (status === 'COMPLETED') {
        text = pollData.text_full || '';
        break;
      }
      if (status === 'FAILED' || status === 'CANCELLED') {
        res.status(502).json({
          error: 'Parse job failed',
          detail: pollData.job && pollData.job.error_message
        });
        return;
      }
      // otherwise PENDING/RUNNING — keep polling
    }

    if (!text) {
      res.status(504).json({ error: 'Timed out waiting for LlamaParse result' });
      return;
    }

    res.status(200).json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Unknown server error' });
  }
}
