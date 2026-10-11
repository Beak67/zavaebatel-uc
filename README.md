# ZAVAEBATEL UC — starter project

Phone-friendly starter for a Telegram Mini App storefront. Includes a dark navy/red/gold UI, custom SVG logo, and a Node/Express server that can read the Nexus Shop catalog without exposing the Nexus token to the browser.

## Current status
- Frontend/demo shell: ready.
- Nexus catalog proxy: ready to configure; exact PUBG UC catalog mapping still needs verification.
- Checkout/payment/order creation: deliberately disabled until the supplier product, required delivery fields, final prices, and permitted payment route are confirmed.
- No real payment should be accepted in this starter.

## Deploy
1. Upload these files to a GitHub repository.
2. Deploy the repository to a Node hosting service that supports environment variables (for example Render).
3. Build command: `npm install`; start command: `npm start`.
4. Add `NEXUS_API_BASE=https://nexus.amadeustech.dev` and `NEXUS_SHOP_TOKEN` as private environment variables in the host dashboard. Never commit the real token to GitHub or place it in `public/`.
5. Open `https://YOUR-SERVICE-URL/api/health` and confirm `{ "ok": true ... }`.
6. Open `/api/catalog` and verify the returned catalog contains the correct PUBG Mobile UC product(s).
7. Only after verifying the product's exact `deliveryData` requirements, supplier price, fulfillment status, and applicable Telegram/payment-provider rules should checkout be implemented.
8. Bind the HTTPS URL to your Telegram bot as its Mini App URL through BotFather.

## Important security notes
- Never put `TELEGRAM_BOT_TOKEN` or `NEXUS_SHOP_TOKEN` in frontend JavaScript or a public Git repository.
- Do not activate unverified orders or accept payments before checking the actual supplier catalog.
- The server intentionally returns HTTP 501 for `/api/orders` until checkout is implemented safely.
- Digital goods sold inside Telegram bots/Mini Apps are subject to Telegram's current payment rules; verify current requirements before choosing a payment flow.
