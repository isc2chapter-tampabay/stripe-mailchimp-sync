export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const signature = request.headers.get("stripe-signature");
    if (!signature) {
      return new Response("Missing Stripe signature", { status: 400 });
    }

    const rawBody = await request.text();

    const verified = await verifyStripeSignature(
      rawBody,
      signature,
      env.STRIPE_WEBHOOK_SECRET
    );

    if (!verified.ok) {
      return new Response("Invalid signature", { status: 400 });
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const HANDLED_EVENTS = [
      "checkout.session.completed",
      "customer.subscription.deleted"
    ];

    if (!HANDLED_EVENTS.includes(event.type)) {
      return new Response("Ignored", { status: 200 });
    }

    // Idempotency: skip already-processed events
    const eventId = event.id;
    if (eventId && env.PROCESSED_EVENTS) {
      const existing = await env.PROCESSED_EVENTS.get(eventId);
      if (existing) {
        return new Response("Already processed", { status: 200 });
      }
    }

    const mailchimpAuth = `Basic ${btoa(`anystring:${env.MAILCHIMP_API_KEY}`)}`;
    const obj = event.data?.object || {};

    if (event.type === "checkout.session.completed") {
      const email = obj.customer_details?.email || obj.customer_email;
      const fullName = obj.customer_details?.name || "";
      const { firstName, lastName } = splitName(fullName);

      if (!email) {
        return new Response("No email on session", { status: 200 });
      }

      // Extract ISC2 member ID from Stripe custom fields
      const isc2Field = (obj.custom_fields || []).find(
        (f) => f.key === "isc2memberidifyourealreadyanisc2member"
      );
      const isc2Number = isc2Field?.text?.value || isc2Field?.value || "";

      const normalizedEmail = email.trim().toLowerCase();
      const subscriberHash = await md5Hex(normalizedEmail);
      const baseUrl = `https://${env.MAILCHIMP_SERVER_PREFIX}.api.mailchimp.com/3.0/lists/${env.MAILCHIMP_LIST_ID}/members/${subscriberHash}`;

      const mergeFields = { FNAME: firstName, LNAME: lastName };
      if (isc2Number) {
        mergeFields.MMERGE3 = isc2Number;
      }

      // 1. Upsert contact
      const upsertOk = await fetchWithRetry(baseUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: mailchimpAuth },
        body: JSON.stringify({
          email_address: normalizedEmail,
          status_if_new: "subscribed",
          merge_fields: mergeFields
        })
      });

      if (!upsertOk) {
        return new Response("OK", { status: 200 });
      }

      // 2. Apply tag
      await fetchWithRetry(`${baseUrl}/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: mailchimpAuth },
        body: JSON.stringify({
          tags: [{ name: env.MAILCHIMP_TAG, status: "active" }]
        })
      });
    }

    if (event.type === "customer.subscription.deleted") {
      // Subscription canceled — look up customer email via Stripe API
      const customerEmail = await getStripeCustomerEmail(obj.customer, env.STRIPE_SECRET_KEY);

      if (!customerEmail) {
        console.error("Could not resolve email for customer:", obj.customer);
        return new Response("OK", { status: 200 });
      }

      const normalizedEmail = customerEmail.trim().toLowerCase();
      const subscriberHash = await md5Hex(normalizedEmail);
      const baseUrl = `https://${env.MAILCHIMP_SERVER_PREFIX}.api.mailchimp.com/3.0/lists/${env.MAILCHIMP_LIST_ID}/members/${subscriberHash}`;

      // Remove active tag and apply canceled tag
      await fetchWithRetry(`${baseUrl}/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: mailchimpAuth },
        body: JSON.stringify({
          tags: [
            { name: env.MAILCHIMP_TAG, status: "inactive" },
            { name: env.MAILCHIMP_CANCEL_TAG, status: "active" }
          ]
        })
      });
    }

    // Mark event as processed (TTL 7 days to avoid unbounded growth)
    if (eventId && env.PROCESSED_EVENTS) {
      ctx.waitUntil(
        env.PROCESSED_EVENTS.put(eventId, "1", { expirationTtl: 604800 })
      );
    }

    return new Response("OK", { status: 200 });
  }
};

/**
 * Fetch with up to 2 retries for transient failures (5xx / network errors).
 * Returns true if the final attempt succeeded, false otherwise.
 */
async function fetchWithRetry(url, options, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok) return true;

      const body = await res.text();
      // Only retry on server errors
      if (res.status >= 500 && attempt < retries) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      console.error(`Mailchimp error ${res.status}: ${body}`);
      return false;
    } catch (err) {
      console.error(`Fetch error (attempt ${attempt + 1}):`, err);
      if (attempt < retries) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      return false;
    }
  }
  return false;
}

async function getStripeCustomerEmail(customerId, stripeSecretKey) {
  try {
    const res = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
      headers: { Authorization: `Bearer ${stripeSecretKey}` }
    });
    if (!res.ok) {
      console.error(`Stripe customer lookup failed: ${res.status}`);
      return null;
    }
    const customer = await res.json();
    return customer.email || null;
  } catch (err) {
    console.error("Stripe customer lookup error:", err);
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitName(fullName) {
  const parts = (fullName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

async function md5Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("MD5", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyStripeSignature(payload, stripeSignature, secret) {
  try {
    const elements = Object.fromEntries(
      stripeSignature.split(",").map((part) => {
        const [k, v] = part.split("=");
        return [k, v];
      })
    );

    const timestamp = elements.t;
    const expectedSig = elements.v1;
    if (!timestamp || !expectedSig) return { ok: false };

    const signedPayload = `${timestamp}.${payload}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signatureBuffer = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(signedPayload)
    );

    const computed = [...new Uint8Array(signatureBuffer)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return { ok: timingSafeEqual(computed, expectedSig) };
  } catch {
    return { ok: false };
  }
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}
