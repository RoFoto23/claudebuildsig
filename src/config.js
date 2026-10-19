/** Central configuration. Reads environment variables only; never hardcode secrets. */
export function loadConfig(env = process.env) {
  const list = (v) =>
    String(v || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  const prodHost = env.VERCEL_PROJECT_PRODUCTION_URL;
  const c = {
    brand: env.BRAND_NAME || 'BuildSignal',
    baseUrl: String(env.APP_URL || (prodHost ? `https://${prodHost}` : 'http://localhost:3000')).replace(/\/$/, ''),
    isProd: env.VERCEL_ENV === 'production',
    supabaseUrl: env.SUPABASE_URL || '',
    supabaseSecret: env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '',
    supabaseAnon: env.SUPABASE_ANON_KEY || '',
    sessionSecret: env.SESSION_SECRET || '',
    tokenSecret: env.TOKEN_SECRET || '',
    encKey: env.ENC_KEY || '',
    cronSecret: env.CRON_SECRET || '',
    resendKey: env.RESEND_API_KEY || '',
    emailFrom: env.EMAIL_FROM || '',
    replyTo: env.REPLY_TO || '',
    mailingAddress: env.MAILING_ADDRESS || '',
    resendWebhookSecret: env.RESEND_WEBHOOK_SECRET || '',
    stripeKey: env.STRIPE_SECRET_KEY || '',
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    samKey: env.SAM_API_KEY || '',
    adminEmails: list(env.ADMIN_EMAILS),
    diagToken: env.DIAG_TOKEN || '',
    inboundDomain: String(env.INBOUND_DOMAIN || '').trim().toLowerCase(),
    llmProvider: String(env.LLM_PROVIDER || 'gemini').trim().toLowerCase(),
    llmModel: env.LLM_MODEL || '',
    llmKey: env.LLM_API_KEY || '',
    allowDevLoginLinks: env.ALLOW_DEV_LOGIN_LINKS === '1' && env.VERCEL_ENV !== 'production',
  };
  c.has = {
    db: Boolean(c.supabaseUrl && c.supabaseSecret),
    anon: Boolean(c.supabaseUrl && c.supabaseAnon),
    email: Boolean(c.resendKey && c.emailFrom),
    billing: Boolean(c.stripeKey && c.stripeWebhookSecret),
    address: Boolean(c.mailingAddress),
    secrets: Boolean(c.sessionSecret && c.tokenSecret && c.encKey),
    inbox: Boolean(c.inboundDomain && c.resendKey && c.emailFrom),
    llm: Boolean(c.llmKey && c.llmModel),
  };
  /** Customers can sign up and start a trial only when every dependency is live. */
  c.signupOpen = c.has.db && c.has.email && c.has.billing && c.has.address && c.has.secrets;
  return c;
}
