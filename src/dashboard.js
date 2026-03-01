import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import {
  listUsers,
  getAllShortTerm,
  getLongTermMemories,
  deleteLongTerm,
  findSimilar,
} from './memory.js';
import { getDailyMood, getDailyThought, setDailyThought } from './mood.js';

export function startDashboard() {
  if (!config.dashboardEnabled) return;

  const app = express();
  app.use((req, res, next) => {
    console.log(`[dashboard] ${req.method} ${req.url}`);
    next();
  });
  app.use(express.json());

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.join(__dirname, './public');
  console.log('[dashboard] static directory:', publicDir);
  const indexPath = path.join(publicDir, 'index.html');
  console.log('[dashboard] index file path:', indexPath);
  import('fs')
    .then((fs) => fs.promises.stat(indexPath))
    .then(() => console.log('[dashboard] index.html is present'))
    .catch((e) => console.warn('[dashboard] index.html missing or inaccessible', e.message));
  app.use(express.static(publicDir));

  app.get('/api/users', async (req, res) => {
    console.log('[dashboard] GET /api/users');
    try {
      const users = await listUsers();
      console.log('[dashboard] returning', users.length, 'users');
      res.json(users);
    } catch (err) {
      console.error('[dashboard] failed to list users', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  app.get('/api/users/:id/short', async (req, res) => {
    console.log('[dashboard] GET /api/users/' + req.params.id + '/short');
    try {
      const rows = await getAllShortTerm(req.params.id);
      res.json(rows);
    } catch (err) {
      console.error('[dashboard] fetch short-term failed', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  app.get('/api/users/:id/long', async (req, res) => {
    console.log('[dashboard] GET /api/users/' + req.params.id + '/long');
    try {
      const rows = await getLongTermMemories(req.params.id);
      res.json(rows);
    } catch (err) {
      console.error('[dashboard] fetch long-term failed', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  app.delete('/api/users/:id/long/:memId', async (req, res) => {
    console.log('[dashboard] DELETE /api/users/' + req.params.id + '/long/' + req.params.memId);
    try {
      await deleteLongTerm(req.params.id, req.params.memId);
      res.json({ ok: true });
    } catch (err) {
      console.error('[dashboard] delete memory failed', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  app.post('/api/users/:id/search', async (req, res) => {
    console.log('[dashboard] POST /api/users/' + req.params.id + '/search', req.body);
    try {
      const { query } = req.body;
      const results = await findSimilar(req.params.id, query);
      res.json(results);
    } catch (err) {
      console.error('[dashboard] similarity search failed', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  app.get('/api/mood', async (req, res) => {
    console.log('[dashboard] GET /api/mood');
    try {
      const thought = await getDailyThought();
      res.json({ mood: getDailyMood(), thought });
    } catch (err) {
      console.error('[dashboard] failed to get mood', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  app.post('/api/mood/thought', async (req, res) => {
    console.log('[dashboard] POST /api/mood/thought', req.body);
    try {
      const { thought } = req.body;
      if (!thought || typeof thought !== 'string') {
        return res.status(400).json({ error: 'thought must be a string' });
      }
      await setDailyThought(thought);
      const updatedThought = await getDailyThought();
      res.json({ ok: true, thought: updatedThought });
    } catch (err) {
      console.error('[dashboard] failed to set thought', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  const port = config.dashboardPort || 3000;
  app.listen(port, () => {
    console.log(`[dashboard] listening on http://localhost:${port}`);
  });
}
