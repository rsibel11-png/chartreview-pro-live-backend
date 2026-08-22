// stripe.js — Stripe checkout + user credit management
// Updated: 2026-08-22 — Initial Stripe per-page payment integration
// Uses Node 20 built-in fetch (no stripe SDK dependency needed)

const crypto = require('crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, UpdateCommand, PutCommand } = require('@aws-sdk/lib-dynamodb');

const ddbClient = new DynamoDBClient({ region: 'us-east-1' });
const ddb = DynamoDBDocumentClient.from(ddbClient);

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const USER_CREDITS_TABLE = process.env.USER_CREDITS_TABLE || 'chartreview-user-credits-prod';
const FREE_USERS = ['rsibel11@gmail.com'];

// ── Tiered pricing (matches original PagePaymentDialog) ──────────────────────
function getPricePerPage(pages) {
  if (pages <= 100) return 0.60;
  if (pages <= 1000) return 0.55;
  if (pages <= 5000) return 0.50;
  if (pages <= 10000) return 0.45;
  return 0.40;
}

// ── Helper: extract user email from API Gateway event ────────────────────────
function getUserEmail(event) {
  const authHeader = event.headers && (event.headers['Authorization'] || event.headers['authorization']);
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.substring(7);
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      return payload.email || null;
    } catch (e) {
      return null;
    }
  }
  return null;
}

// ── Helper: build CORS response ──────────────────────────────────────────────
function corsResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-api-key,x-org-id',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

function corsPreflight() {
  return {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-api-key,x-org-id',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    },
    body: '',
  };
}

// ── Helper: ensure user record exists in credits table ──────────────────────
async function ensureUserRecord(userEmail) {
  const existing = await ddb.send(new GetCommand({
    TableName: USER_CREDITS_TABLE,
    Key: { user_email: userEmail },
  }));

  if (!existing.Item) {
    const isNewFreeUser = FREE_USERS.includes(userEmail);
    await ddb.send(new PutCommand({
      TableName: USER_CREDITS_TABLE,
      Item: {
        user_email: userEmail,
        page_credits: 0,
        free_pages_remaining: isNewFreeUser ? 100000 : 100,
        free_pages_reset_date: new Date(new Date().setMonth(new Date().getMonth() + 1)).toISOString(),
        stripe_customer_id: null,
        created_date: new Date().toISOString(),
      },
    }));
  }

  const result = await ddb.send(new GetCommand({
    TableName: USER_CREDITS_TABLE,
    Key: { user_email: userEmail },
  }));
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// getUserCredits — GET /stripe/credits
// ═══════════════════════════════════════════════════════════════════════════════
async function getUserCredits(event) {
  if (event.httpMethod === 'OPTIONS') return corsPreflight();

  const userEmail = getUserEmail(event);
  if (!userEmail) return corsResponse(401, { error: 'Unauthorized' });

  try {
    const result = await ensureUserRecord(userEmail);
    const item = result.Item || {};
    const isFreeUser = FREE_USERS.includes(userEmail);

    return corsResponse(200, {
      email: userEmail,
      page_credits: item.page_credits || 0,
      free_pages_remaining: isFreeUser ? 100000 : (item.free_pages_remaining || 0),
      free_pages_reset_date: item.free_pages_reset_date || null,
      stripe_customer_id: item.stripe_customer_id || null,
      is_admin: isFreeUser,
    });
  } catch (err) {
    console.error('getUserCredits error:', err);
    return corsResponse(500, { error: 'Failed to fetch credits: ' + err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// createCheckoutSession — POST /stripe/checkout
// Body: { pages, amountCents, returnPath }
// ═══════════════════════════════════════════════════════════════════════════════
async function createCheckoutSession(event) {
  if (event.httpMethod === 'OPTIONS') return corsPreflight();

  const userEmail = getUserEmail(event);
  if (!userEmail) return corsResponse(401, { error: 'Unauthorized' });

  try {
    const body = JSON.parse(event.body || '{}');
    const { pages, amountCents, returnPath } = body;

    if (!pages || !amountCents) {
      return corsResponse(400, { error: 'Missing pages or amountCents' });
    }

    // Ensure user record exists and get/create Stripe customer ID
    const userResult = await ensureUserRecord(userEmail);
    let customerId = userResult.Item && userResult.Item.stripe_customer_id;

    if (!customerId) {
      const customerResp = await fetch('https://api.stripe.com/v1/customers', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          email: userEmail,
          'metadata[user_email]': userEmail,
        }).toString(),
      });
      const customer = await customerResp.json();
      if (!customer.id) {
        return corsResponse(500, { error: 'Failed to create Stripe customer' });
      }
      customerId = customer.id;

      await ddb.send(new UpdateCommand({
        TableName: USER_CREDITS_TABLE,
        Key: { user_email: userEmail },
        UpdateExpression: 'SET stripe_customer_id = :cid',
        ExpressionAttributeValues: { ':cid': customerId },
      }));
    }

    const origin = event.headers && (event.headers.Origin || event.headers.origin) ||
                   (event.headers && event.headers.Referer && event.headers.Referer.replace(/\/$/, '')) ||
                   'https://chartreviewpro.com';

    const successUrl = `${origin}${returnPath || '/'}`;
    const cancelUrl = `${origin}/Upload`;

    const params = new URLSearchParams({
      'customer': customerId,
      'mode': 'payment',
      'success_url': successUrl,
      'cancel_url': cancelUrl,
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(amountCents),
      'line_items[0][price_data][product_data][name]': `${pages.toLocaleString()} Page Credits`,
      'line_items[0][price_data][product_data][description]': `One-time upload payment for ${pages} pages — credits never expire`,
      'line_items[0][quantity]': '1',
      'metadata[page_credits]': String(pages),
      'metadata[user_email]': userEmail,
      'metadata[payment_type]': 'upload_payment',
    });

    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const session = await resp.json();
    if (!session.url) {
      console.error('Stripe checkout error:', session);
      return corsResponse(500, { error: session.error ? session.error.message : 'Failed to create checkout session' });
    }

    console.log(`Created checkout session ${session.id} for ${pages} pages ($${(amountCents / 100).toFixed(2)}) for user ${userEmail}`);
    return corsResponse(200, { url: session.url });
  } catch (err) {
    console.error('createCheckoutSession error:', err);
    return corsResponse(500, { error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// stripeWebhook — POST /stripe/webhook
// NO auth — Stripe calls this server-to-server
// ═══════════════════════════════════════════════════════════════════════════════
async function stripeWebhook(event) {
  try {
    const signature = event.headers && (event.headers['Stripe-Signature'] || event.headers['stripe-signature']);
    const rawBody = event.body || '';

    if (!signature || !STRIPE_WEBHOOK_SECRET) {
      console.error('Missing signature or webhook secret');
      return corsResponse(400, { error: 'Missing signature or webhook secret not configured' });
    }

    const sigVerified = verifyStripeSignature(rawBody, signature, STRIPE_WEBHOOK_SECRET);
    if (!sigVerified) {
      console.error('Invalid webhook signature');
      return corsResponse(400, { error: 'Invalid signature' });
    }

    const stripeEvent = JSON.parse(rawBody);
    console.log('Webhook event:', stripeEvent.type);

    if (stripeEvent.type === 'checkout.session.completed') {
      const session = stripeEvent.data.object;

      if (session.mode !== 'payment') {
        console.log('Skipping non-payment session');
        return corsResponse(200, { received: true });
      }

      const pageCredits = parseInt(session.metadata && session.metadata.page_credits, 10);
      const userEmail = session.metadata && session.metadata.user_email;

      if (!userEmail || !pageCredits) {
        console.error('Missing metadata in session:', session.id);
        return corsResponse(200, { received: true });
      }

      await ddb.send(new UpdateCommand({
        TableName: USER_CREDITS_TABLE,
        Key: { user_email: userEmail },
        UpdateExpression: 'SET page_credits = if_not_exists(page_credits, :zero) + :credits',
        ExpressionAttributeValues: {
          ':credits': pageCredits,
          ':zero': 0,
        },
      }));

      console.log(`Added ${pageCredits} page credits to user: ${userEmail}`);
    }

    return corsResponse(200, { received: true });
  } catch (err) {
    console.error('stripeWebhook error:', err);
    return corsResponse(400, { error: err.message });
  }
}

// ── Stripe signature verification (no SDK needed) ───────────────────────────
function verifyStripeSignature(rawBody, signature, secret) {
  try {
    const parts = signature.split(',');
    const timestampPart = parts.find(p => p.startsWith('t='));
    const signaturePart = parts.find(p => p.startsWith('v1='));

    if (!timestampPart || !signaturePart) return false;

    const timestamp = timestampPart.split('=')[1];
    const expectedSig = signaturePart.split('=')[1];

    const age = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
    if (age > 300) return false;

    const signedPayload = `${timestamp}.${rawBody}`;
    const hmac = crypto.createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(hmac, 'hex'),
      Buffer.from(expectedSig, 'hex')
    );
  } catch (e) {
    console.error('Signature verification error:', e);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// deductCredits — POST /stripe/deduct
// Body: { pages }
// ═══════════════════════════════════════════════════════════════════════════════
async function deductCredits(event) {
  if (event.httpMethod === 'OPTIONS') return corsPreflight();

  const userEmail = getUserEmail(event);
  if (!userEmail) return corsResponse(401, { error: 'Unauthorized' });

  if (FREE_USERS.includes(userEmail)) {
    return corsResponse(200, { success: true, remaining: 100000, message: 'Admin bypass' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { pages } = body;

    if (!pages || pages <= 0) {
      return corsResponse(400, { error: 'Missing pages count' });
    }

    await ensureUserRecord(userEmail);

    const current = await ddb.send(new GetCommand({
      TableName: USER_CREDITS_TABLE,
      Key: { user_email: userEmail },
    }));

    const item = current.Item || {};
    const pageCredits = item.page_credits || 0;
    const freePages = item.free_pages_remaining || 0;
    const total = pageCredits + freePages;

    if (total < pages) {
      return corsResponse(402, { error: 'Insufficient credits', needed: pages, available: total });
    }

    let deductFromFree = Math.min(freePages, pages);
    let deductFromPurchased = pages - deductFromFree;

    const updateExpr = [];
    const exprValues = {};

    if (deductFromFree > 0) {
      updateExpr.push('free_pages_remaining = free_pages_remaining - :free');
      exprValues[':free'] = deductFromFree;
    }
    if (deductFromPurchased > 0) {
      updateExpr.push('page_credits = page_credits - :purch');
      exprValues[':purch'] = deductFromPurchased;
    }

    if (updateExpr.length > 0) {
      await ddb.send(new UpdateCommand({
        TableName: USER_CREDITS_TABLE,
        Key: { user_email: userEmail },
        UpdateExpression: 'SET ' + updateExpr.join(', '),
        ExpressionAttributeValues: exprValues,
      }));
    }

    const newTotal = total - pages;
    console.log(`Deducted ${pages} credits from ${userEmail} (free: ${deductFromFree}, purchased: ${deductFromPurchased}), remaining: ${newTotal}`);

    return corsResponse(200, {
      success: true,
      deducted: pages,
      remaining: newTotal,
    });
  } catch (err) {
    console.error('deductCredits error:', err);
    return corsResponse(500, { error: err.message });
  }
}

module.exports = {
  getUserCredits,
  createCheckoutSession,
  stripeWebhook,
  deductCredits,
};
