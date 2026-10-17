import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { pool, transaction } from "./db.js";

const scrypt = promisify(scryptCallback);
const SESSION_DAYS = 30;
const PASSWORD_N = 2 ** 15;
const PASSWORD_R = 8;
const PASSWORD_P = 3;
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID ?? "").trim();
const GOOGLE_CLIENT_SECRET = String(process.env.GOOGLE_CLIENT_SECRET ?? "").trim();
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function safeEqual(left, right) {
  return timingSafeEqual(createHash("sha256").update(String(left)).digest(), createHash("sha256").update(String(right)).digest());
}

export function normalizeEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error("Enter a valid email address."), { status: 422 });
  return email;
}

export function validatePassword(value) {
  const password = String(value ?? "");
  if (password.length < 12) throw Object.assign(new Error("Use at least 12 characters for your password."), { status: 422 });
  if (password.length > 128) throw Object.assign(new Error("Password must be 128 characters or fewer."), { status: 422 });
  return password;
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(validatePassword(password), salt, 64, { N: PASSWORD_N, r: PASSWORD_R, p: PASSWORD_P, maxmem: 64 * 1024 * 1024 });
  return `$scrypt$${PASSWORD_N}$${PASSWORD_R}$${PASSWORD_P}$${salt.toString("base64url")}$${Buffer.from(derived).toString("base64url")}`;
}

export async function verifyPassword(password, digest) {
  const parts = String(digest ?? "").split("$");
  if (parts.length !== 7 || parts[1] !== "scrypt") return false;
  const [, , n, r, p, saltValue, hashValue] = parts;
  const expected = Buffer.from(hashValue, "base64url");
  const derived = await scrypt(String(password ?? ""), Buffer.from(saltValue, "base64url"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

function publicUser(row) {
  return { id: Number(row.id), email: row.email, name: row.name, isAdmin: Boolean(row.is_admin) };
}

export async function registerWithPassword(input) {
  const email = normalizeEmail(input.email);
  const passwordDigest = await hashPassword(input.password);
  const name = String(input.name ?? "").trim().slice(0, 100);
  if (name.length < 2) throw Object.assign(new Error("Enter your name."), { status: 422 });
  try {
    return await transaction(async (client) => {
      const created = await client.query(`INSERT INTO profiles(name,email,postcode,address,default_min_saving) VALUES ($1,$2,'','',1) RETURNING id,email,name,is_admin`, [name, email]);
      await client.query(`INSERT INTO password_credentials(profile_id,password_digest) VALUES ($1,$2)`, [created.rows[0].id, passwordDigest]);
      return publicUser(created.rows[0]);
    });
  } catch (error) {
    if (error.code === "23505") throw Object.assign(new Error("An account already exists for this email."), { status: 409 });
    throw error;
  }
}

export async function authenticatePassword(emailValue, password) {
  const email = normalizeEmail(emailValue);
  const result = await pool.query(`SELECT p.id,p.email,p.name,p.is_admin,c.password_digest FROM profiles p JOIN password_credentials c ON c.profile_id=p.id WHERE lower(p.email)=lower($1)`, [email]);
  const credential = result.rows[0];
  const valid = credential ? await verifyPassword(password, credential.password_digest) : await verifyPassword(password, "$scrypt$32768$8$3$MDAwMDAwMDAwMDAwMDAwMA$MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMA");
  if (!credential || !valid) throw Object.assign(new Error("Email or password is incorrect."), { status: 401 });
  return publicUser(credential);
}

export async function createSession(profileId, userAgent = "") {
  const token = randomToken();
  await pool.query(`INSERT INTO auth_sessions(profile_id,token_hash,user_agent,expires_at) VALUES ($1,$2,$3,now()+($4 || ' days')::interval)`, [profileId, sha256(token), String(userAgent).slice(0, 500), SESSION_DAYS]);
  return token;
}

export async function sessionUser(token) {
  if (!token) return null;
  const result = await pool.query(`SELECT p.id,p.email,p.name,p.is_admin,s.id AS session_id,s.last_seen_at FROM auth_sessions s JOIN profiles p ON p.id=s.profile_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()`, [sha256(token)]);
  if (!result.rowCount) return null;
  const row = result.rows[0];
  if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60_000) await pool.query(`UPDATE auth_sessions SET last_seen_at=now() WHERE id=$1`, [row.session_id]);
  return publicUser(row);
}

export async function revokeSession(token) {
  if (token) await pool.query(`UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE token_hash=$1`, [sha256(token)]);
}

export function googleEnabled() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

export async function beginGoogleLogin(redirectUri) {
  if (!googleEnabled()) throw Object.assign(new Error("Google sign-in is not configured yet."), { status: 503 });
  const state = randomToken();
  const nonce = randomToken();
  const codeVerifier = randomToken(48);
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  await pool.query(`DELETE FROM oauth_login_attempts WHERE expires_at<=now()`);
  await pool.query(`INSERT INTO oauth_login_attempts(state_hash,nonce,code_verifier,expires_at) VALUES ($1,$2,$3,now()+interval '10 minutes')`, [sha256(state), nonce, codeVerifier]);
  const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  target.search = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, redirect_uri: redirectUri, response_type: "code", scope: "openid email profile", state, nonce, code_challenge: codeChallenge, code_challenge_method: "S256", prompt: "select_account" }).toString();
  return { state, location: target.href };
}

export async function completeGoogleLogin({ state, cookieState, code, redirectUri, userAgent }) {
  if (!googleEnabled()) throw Object.assign(new Error("Google sign-in is not configured yet."), { status: 503 });
  if (!state || !cookieState || !safeEqual(state, cookieState)) throw Object.assign(new Error("Google sign-in state is invalid or expired."), { status: 401 });
  const attempt = await pool.query(`DELETE FROM oauth_login_attempts WHERE state_hash=$1 AND expires_at>now() RETURNING nonce,code_verifier`, [sha256(state)]);
  if (!attempt.rowCount) throw Object.assign(new Error("Google sign-in state is invalid or expired."), { status: 401 });
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: attempt.rows[0].code_verifier }),
    signal: AbortSignal.timeout(15_000),
  });
  const tokens = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokens.id_token) throw Object.assign(new Error("Google could not complete sign-in."), { status: 401 });
  const { payload } = await jwtVerify(tokens.id_token, googleKeys, { issuer: ["https://accounts.google.com", "accounts.google.com"], audience: GOOGLE_CLIENT_ID });
  if (payload.nonce !== attempt.rows[0].nonce || !payload.sub || payload.email_verified !== true) throw Object.assign(new Error("Google identity verification failed."), { status: 401 });
  const email = normalizeEmail(payload.email);
  const name = String(payload.name ?? email.split("@")[0]).trim().slice(0, 100);
  const user = await transaction(async (client) => {
    const existingIdentity = await client.query(`SELECT p.id,p.email,p.name,p.is_admin FROM auth_identities i JOIN profiles p ON p.id=i.profile_id WHERE i.provider='google' AND i.subject=$1`, [payload.sub]);
    if (existingIdentity.rowCount) {
      await client.query(`UPDATE auth_identities SET email=$1,last_login_at=now() WHERE provider='google' AND subject=$2`, [email, payload.sub]);
      return publicUser(existingIdentity.rows[0]);
    }
    let profile = await client.query(`SELECT id,email,name,is_admin FROM profiles WHERE lower(email)=lower($1)`, [email]);
    if (!profile.rowCount) profile = await client.query(`INSERT INTO profiles(name,email,postcode,address,default_min_saving) VALUES ($1,$2,'','',1) RETURNING id,email,name,is_admin`, [name, email]);
    await client.query(`INSERT INTO auth_identities(profile_id,provider,subject,email) VALUES ($1,'google',$2,$3)`, [profile.rows[0].id, payload.sub, email]);
    return publicUser(profile.rows[0]);
  });
  return { user, token: await createSession(user.id, userAgent) };
}

export async function ensureBootstrapCredential() {
  const emailValue = String(process.env.BOOTSTRAP_ADMIN_EMAIL ?? "").trim();
  const password = String(process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "");
  if (!emailValue || !password) return false;
  const email = normalizeEmail(emailValue);
  const passwordDigest = await hashPassword(password);
  await transaction(async (client) => {
    await client.query(`UPDATE profiles SET email=$1,is_admin=true,updated_at=now() WHERE id=1`, [email]);
    await client.query(`
      INSERT INTO password_credentials(profile_id,password_digest) VALUES (1,$1)
      ON CONFLICT(profile_id) DO UPDATE SET password_digest=EXCLUDED.password_digest,updated_at=now()
    `, [passwordDigest]);
  });
  return true;
}
