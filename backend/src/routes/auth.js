import express from "express";
import crypto from "node:crypto";
import prisma from "../lib/prisma.js";
import { authenticate, checkPassword, makePasswordHash } from "../middleware/auth.js";
import { createEmailOtp, sendVerificationEmail, verifyEmailOtp } from "../lib/email.js";

const router = express.Router();
const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

function normalizeEmail(email) { return String(email || "").trim().toLowerCase(); }

async function issuePasswordResetOtp(user) {
  const now = new Date();
  if (user.emailVerificationLastSentAt && now.getTime() - user.emailVerificationLastSentAt.getTime() < RESEND_COOLDOWN_MS) {
    const retryAfter = Math.ceil((RESEND_COOLDOWN_MS - (now.getTime() - user.emailVerificationLastSentAt.getTime())) / 1000);
    const error = new Error(`Please wait ${retryAfter} seconds before requesting another code`);
    error.status = 429;
    throw error;
  }
  const { otp, hash } = createEmailOtp("reset:" + user.email);
  await sendVerificationEmail({
    to: user.email,
    name: user.name,
    otp,
    subject: "Reset your PARAKH password",
    heading: "Reset your PARAKH password",
    intro: "Your password reset code is:"
  });
  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerificationOtpHash: hash,
      emailVerificationOtpExpiresAt: new Date(Date.now() + OTP_TTL_MS),
      emailVerificationLastSentAt: now,
      emailVerificationAttempts: 0
    }
  });
}

router.post("/register", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    if (!name || !email || password.length < 6) {
      return res.status(400).json({ error: "Name, email and a password of at least 6 characters are required" });
    }

    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) return res.status(409).json({ error: "An account with this email already exists" });

    const token = crypto.randomBytes(32).toString("hex");
    const user = await prisma.user.create({
      data: {
        name,
        email,
        role: "USER",
        passwordHash: makePasswordHash(password),
        emailVerified: false,
        sessions: {
          create: {
            token,
            expiresAt: new Date(Date.now() + SESSION_TTL_MS)
          }
        }
      }
    });

    res.status(201).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        emailVerified: user.emailVerified
      }
    });
  } catch (error) {
    console.error(error);
    res.status(error?.status || 500).json({
      error: error?.code === "P2002"
        ? "An account with this email already exists"
        : (error?.message || "Registration failed")
    });
  }
});



router.post("/forgot-password", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email) return res.status(400).json({ error: "Email is required" });
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) await issuePasswordResetOtp(user);
    res.json({ message: "If an account exists for that email, a reset code has been sent" });
  } catch (error) { console.error(error); res.status(error?.status || 500).json({ error: error?.message || "Unable to send reset code" }); }
});

router.post("/reset-password", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email); const otp = String(req.body.otp || "").trim(); const password = String(req.body.password || "");
    if (!email || !/^\d{6}$/.test(otp) || password.length < 6) return res.status(400).json({ error: "Email, 6-digit code and a password of at least 6 characters are required" });
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.emailVerificationOtpHash || !user.emailVerificationOtpExpiresAt || user.emailVerificationOtpExpiresAt < new Date()) return res.status(400).json({ error: "This reset code has expired. Request a new code." });
    if (user.emailVerificationAttempts >= MAX_OTP_ATTEMPTS) return res.status(429).json({ error: "Too many incorrect attempts. Request a new reset code." });
    const valid = verifyEmailOtp(`reset:${email}`, otp, user.emailVerificationOtpHash);
    if (!valid) { await prisma.user.update({ where: { id: user.id }, data: { emailVerificationAttempts: { increment: 1 } } }); return res.status(400).json({ error: "Invalid reset code" }); }
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash: makePasswordHash(password), emailVerificationOtpHash: null, emailVerificationOtpExpiresAt: null, emailVerificationLastSentAt: null, emailVerificationAttempts: 0 } }),
      prisma.session.deleteMany({ where: { userId: user.id } })
    ]);
    res.json({ message: "Password reset successfully" });
  } catch (error) { console.error(error); res.status(500).json({ error: error?.message || "Password reset failed" }); }
});

router.post("/login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email); const password = String(req.body.password || "");
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !checkPassword(password, user.passwordHash)) return res.status(401).json({ error: "Invalid email or password" });
    const token = crypto.randomBytes(32).toString("hex");
    await prisma.session.create({ data: { token, userId: user.id, expiresAt: new Date(Date.now() + SESSION_TTL_MS) } });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, emailVerified: user.emailVerified } });
  } catch (error) { console.error(error); res.status(500).json({ error: error?.message || "Login failed" }); }
});

router.get("/me", authenticate, async (req, res) => { res.json({ id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role, emailVerified: req.user.emailVerified }); });
router.post("/logout", authenticate, async (req, res) => { await prisma.session.delete({ where: { id: req.session.id } }); res.json({ message: "Logged out" }); });

export default router;
