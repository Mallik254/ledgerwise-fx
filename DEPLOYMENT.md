# Ledgerwise FX — Production Deployment Guide

## Why Deployment Failed Before
1. **Peer Dependency Conflict**: `package.json` had a version clash between `vite` (which required `esbuild ^0.28.0`) and direct `esbuild ^0.25.0`. This caused `npm install` on Netlify or cloud servers to abort with `ERESOLVE could not resolve`. *(Fixed: updated to `esbuild ^0.28.0`)*.
2. **Server Architecture vs Static Hosting**: Ledgerwise FX is a **Full-Stack Application** featuring an Express server, Gemini AI processing (`/api/chat`), and real-time WebSockets (`/ws/live` Gemini Live Voice streaming). Standard static hosting (like uploading to basic Netlify or GitHub Pages) only serves HTML files; it does not run the backend server, causing the AI tools to fail.
3. **Production Server Build**: The build process now compiles both the Vite client (`dist/`) and a standalone production Node server (`server.js`) that runs seamlessly on any cloud host.

---

## Recommended Deployment: Render.com or Railway (Easiest & Complete)
Both platforms natively support long-running Node.js servers and WebSockets out of the box, preserving 100% of Ledgerwise FX's features (including Gemini 3.8 Live Voice).

### Option A: Render.com (Free Tier Available)
1. Push your repository to **GitHub**.
2. Sign in to [Render.com](https://render.com) and click **New + > Web Service**.
3. Select your repository.
4. Configure the settings:
   - **Environment**: `Node`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
5. In **Environment Variables**, add:
   - `GEMINI_API_KEY`: Your Google Gemini API Key
   - `NODE_ENV`: `production`
   - *(Optional)* `EXA_API_KEY` or `TAVILY_API_KEY` or `SERPER_API_KEY` for live web search
6. Click **Deploy Web Service**.

### Option B: Railway.app
1. Push your repository to **GitHub**.
2. Sign in to [Railway.app](https://railway.app) and select **New Project > Deploy from GitHub repo**.
3. Railway automatically detects Node.js and runs `npm run build` and `npm start`.
4. In **Variables**, add:
   - `GEMINI_API_KEY`: Your Google Gemini API Key
   - `NODE_ENV`: `production`
5. Under **Settings > Networking**, click **Generate Domain**.

---

## Alternative: Netlify Deployment
If you specifically need to host on Netlify:
1. Ensure the repo has `netlify.toml` (included in project).
2. Set Build settings:
   - **Build command**: `npm run build`
   - **Publish directory**: `dist`
3. Add Environment Variables in Netlify Dashboard:
   - `GEMINI_API_KEY`
4. *Note on Netlify*: Standard AI Chat, Playbooks, Journal, and Risk Tools work; however, WebSockets (`/ws/live` Live Voice) require a persistent server (Render/Railway).
