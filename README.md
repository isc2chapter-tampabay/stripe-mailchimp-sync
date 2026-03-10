# Stripe to Mailchimp Sync

A Cloudflare Worker that syncs Stripe subscription customers to a Mailchimp audience via webhooks.

## What It Does

When a customer completes a Stripe Checkout subscription:
1. Adds (or updates) the contact in your Mailchimp audience
2. Sets their first name, last name, and ISC2 member ID (if provided)
3. Applies the `ISC2ChapterMembers` tag

When a subscription is canceled:
1. Removes the `ISC2ChapterMembers` tag
2. Applies the `ISC2ChapterCancelled` tag
3. The contact remains in Mailchimp (not deleted)

## Architecture

```
Stripe Webhook → Cloudflare Worker → Mailchimp Marketing API
                        ↓
                  Cloudflare KV (deduplication)
```

- **No direct connection** between Stripe and Mailchimp
- The worker is the integration layer

## Stripe Events Handled

| Event | Action |
|---|---|
| `checkout.session.completed` | Upsert contact + apply member tag |
| `customer.subscription.deleted` | Remove member tag + apply canceled tag |

All other events are ignored (returns 200).

## Data Mapping

### Stripe → Mailchimp Fields

| Stripe Source | Mailchimp Merge Tag | Description |
|---|---|---|
| `customer_details.name` (first token) | `FNAME` | First name |
| `customer_details.name` (remainder) | `LNAME` | Last name |
| `customer_details.email` | `email_address` | Email (used as key) |
| Custom field `isc2memberidifyourealreadyanisc2member` | `MMERGE3` | ISC2 member number |

### Tags

| Tag | When Applied |
|---|---|
| Value of `MAILCHIMP_TAG` (e.g., `ISC2ChapterMembers`) | Checkout completed |
| Value of `MAILCHIMP_CANCEL_TAG` (e.g., `ISC2ChapterCancelled`) | Subscription canceled |

## Deployed URL

```
https://stripe-mailchimp-sync.jgrose.workers.dev
```

## Environment Secrets

All secrets are stored in Cloudflare Workers and set via `pnpm wrangler secret put <NAME>`.

| Secret | Where to Find It |
|---|---|
| `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard → Developers → Webhooks → your endpoint → Signing secret (`whsec_...`) |
| `STRIPE_SECRET_KEY` | Stripe Dashboard → Developers → API keys (`sk_live_...` or `sk_test_...`) |
| `MAILCHIMP_API_KEY` | Mailchimp → Account → Extras → API keys |
| `MAILCHIMP_SERVER_PREFIX` | The suffix of your Mailchimp API key (e.g., `us17`) |
| `MAILCHIMP_LIST_ID` | Mailchimp → Audience → Settings → Audience name and defaults → Audience ID |
| `MAILCHIMP_TAG` | Your choice (currently `ISC2ChapterMembers`) |
| `MAILCHIMP_CANCEL_TAG` | Your choice (currently `ISC2ChapterCancelled`) |

## Cloudflare KV

A KV namespace `PROCESSED_EVENTS` is used for idempotency. Processed Stripe event IDs are stored with a 7-day TTL to prevent duplicate processing when Stripe retries webhooks.

The KV namespace ID is configured in `wrangler.toml`.

## Security

- All incoming requests must have a valid `Stripe-Signature` header (HMAC-SHA256)
- Signature verification uses timing-safe comparison
- Unsigned or invalid requests are rejected with 400
- All API keys are stored as Cloudflare Worker secrets (not in code)

## Error Handling

- **Mailchimp errors**: Logged via `console.error`, but the worker still returns 200 to Stripe to prevent retry storms
- **Transient failures**: Mailchimp API calls retry up to 2 times with backoff (500ms, 1s) on 5xx errors
- **Missing email**: Exits gracefully with 200
- **Duplicate events**: Skipped via KV lookup, returns 200

## Development

```bash
# Install dependencies
pnpm install

# Run locally
pnpm dev

# Deploy
pnpm run publish

# Set a secret
pnpm wrangler secret put SECRET_NAME

# View live logs
pnpm wrangler tail
```

Note: `pnpm run publish` (not `pnpm publish`) — the `run` is required because `pnpm publish` is a built-in pnpm command.

## Stripe Webhook Setup

1. Go to Stripe Dashboard → Developers → Webhooks
2. Add endpoint: `https://stripe-mailchimp-sync.jgrose.workers.dev`
3. Select events:
   - `checkout.session.completed`
   - `customer.subscription.deleted`
4. Copy the signing secret and set it as `STRIPE_WEBHOOK_SECRET`

## Mailchimp Audience Setup

The Mailchimp audience must have these merge fields configured:
- `FNAME` — First name (default)
- `LNAME` — Last name (default)
- `MMERGE3` — ISC2 member number (custom field, labeled "ISC2Number" in the UI)

Tags are created automatically by Mailchimp when first applied.

## File Structure

```
├── src/
│   └── index.js        # Worker entry point (all logic in one file)
├── wrangler.toml        # Cloudflare Worker config + KV binding
├── package.json
└── README.md
```
