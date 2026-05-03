# Free Hosting On Cloudflare

ResuLens uses two free Cloudflare products:

- Cloudflare Workers for the API
- Cloudflare Pages for the React app

## 1. Deploy The Worker API

From `server`:

```bash
npx wrangler login
npx wrangler secret put OPENROUTER_API_KEY
npm run deploy
```

After deploy, note the Worker URL:

```text
https://resulens-api.<your-subdomain>.workers.dev
```

## 2. Deploy The React App

From `client`, create `.env.production`:

```bash
VITE_API_BASE_URL=https://resulens-api.<your-subdomain>.workers.dev
```

Then deploy to Cloudflare Pages:

```bash
npm run deploy
```

The app will be hosted at:

```text
https://resulens.pages.dev
```

## 3. Cloudflare Dashboard Alternative

You can also host from the Cloudflare dashboard:

1. Create a Pages project.
2. Connect this repo.
3. Set root directory to `client`.
4. Set build command to `npm run build`.
5. Set build output directory to `dist`.
6. Add environment variable `VITE_API_BASE_URL` with the Worker URL.
7. Deploy.

## Notes

- `client/public/_redirects` keeps `/history` and `/result/:id` working on refresh.
- `OPENROUTER_API_KEY` must be a Worker secret, not a Pages variable.
- The free OpenRouter model is configured in `server/wrangler.jsonc`.
