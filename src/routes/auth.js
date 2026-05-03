/**
 * Authentication Routes & Middleware
 * ====================================
 * Uses @oaauth/sdk which handles the OIDC / OAuth 2.0 flow:
 *
 * Flow:
 *   1. GET /auth/login        → SDK redirects user to Identity Provider
 *   2. IdP authenticates user
 *   3. GET /auth/callback     → SDK exchanges code for tokens, creates session
 *   4. Tokens stored: accessToken in memory (short-lived), refreshToken in httpOnly cookie
 *   5. GET /auth/me           → Returns current user (protected)
 *   6. POST /auth/refresh     → Uses refreshToken cookie to get new accessToken
 *   7. POST /auth/logout      → Clears session + cookie
 *
 * Socket auth:
 *   Client sends accessToken in socket handshake auth:
 *     io({ auth: { token: accessToken } })
 *   The verifySocketToken middleware validates it before any socket event.
 *
 * WHY OIDC over simple JWT?
 * OIDC gives us a standardised discovery document, userinfo endpoint,
 * and token introspection — so we're not building auth logic ourselves.
 * The SDK abstracts the code exchange, PKCE, and token refresh.
 */

import express from "express";
import { AuthClient } from "@oaauth/sdk";
import jwt from "jsonwebtoken";

export const authRouter = express.Router();

// Initialise once and reuse — AuthClient is stateless
const auth = new AuthClient({
  sdkKey:      process.env.SDK_KEY,
  gatewayUrl:  process.env.SDK_GATEWAY_URL,
  redirectUri: process.env.OIDC_REDIRECT_URI || "http://localhost:8000/auth/callback",
});

// ─── Public endpoints ─────────────────────────────────────────

// Redirect to IdP login page
authRouter.get("/login", auth.login);

// IdP redirects here after authentication
authRouter.get("/callback", async (req, res) => {
  try {
    const result = await auth.handleCallbackAndCreateSession(req);

    // httpOnly + sameSite prevents XSS and CSRF abuse of the refresh token
    res.cookie("refreshToken", result.refreshToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    // Redirect to frontend with accessToken as a query param so the SPA
    // can store it in memory (NOT localStorage — XSS risk)
    const redirectUrl = new URL("/", process.env.APP_URL || "http://localhost:8000");
    redirectUrl.searchParams.set("token", result.accessToken);
    res.redirect(redirectUrl.toString());
  } catch (err) {
    console.error("[auth] callback error:", err.message);
    res.redirect("/?error=auth_failed");
  }
});

// Exchange refreshToken cookie for a new accessToken
authRouter.post("/refresh", auth.refreshRoute());

// Clear session and cookie
authRouter.post("/logout", auth.logoutRoute());

// ─── Protected endpoints ──────────────────────────────────────

// Returns the current authenticated user's profile
authRouter.get("/me", auth.protect(), (req, res) => {
  res.json({ user: req.user });
});

// ─── Socket authentication helper ─────────────────────────────

/**
 * Verify a JWT accessToken passed in socket handshake.
 * Used in index.js as a Socket.IO middleware.
 *
 * Usage:
 *   io.use(verifySocketToken);
 *
 * @param {import("socket.io").Socket} socket
 * @param {Function} next
 */
export function verifySocketToken(socket, next) {
  const token = socket.handshake.auth?.token;

  if (!token) {
    // Allow anonymous connections — they get read-only access
    socket.data.user = null;
    socket.data.isAuthenticated = false;
    return next();
  }

  try {
    // Verify against the same secret the IdP uses for access tokens
    // In a real OIDC setup you'd fetch the JWKS and verify the RS256 sig
    const payload = jwt.verify(token, process.env.JWT_SECRET || "dev-secret");
    socket.data.user = payload;
    socket.data.isAuthenticated = true;
    next();
  } catch (_err) {
    // Invalid token → anonymous mode, not a hard failure
    socket.data.user = null;
    socket.data.isAuthenticated = false;
    next();
  }
}

/**
 * Express middleware — injects req.user from Bearer token.
 * Used for REST API endpoints that need to know who is calling.
 */
export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    req.user = null;
    return next();
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || "dev-secret");
  } catch {
    req.user = null;
  }
  next();
}