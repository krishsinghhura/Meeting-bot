import crypto from "crypto";
import type { Request, Response } from "express";
import {
  createUser,
  createUserSession,
  deleteUserSession,
  findUserByEmail,
  findUserBySessionTokenHash,
} from "../storage";

const SESSION_COOKIE_NAME = "meeting_bot_session";
const SESSION_DAYS = 30;
const PASSWORD_ITERATIONS = 210000;
const PASSWORD_KEYLEN = 32;
const PASSWORD_DIGEST = "sha256";

export type AuthenticatedUser = {
  id: string;
  email: string;
};

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function validateEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validatePassword(password: string) {
  return password.length >= 8;
}

export async function registerUser(email: string, password: string) {
  const normalizedEmail = normalizeEmail(email);
  if (!validateEmail(normalizedEmail)) {
    throw new Error("invalid_email");
  }
  if (!validatePassword(password)) {
    throw new Error("weak_password");
  }

  const passwordHash = await hashPassword(password);
  return await createUser(normalizedEmail, passwordHash);
}

export async function authenticateUser(email: string, password: string) {
  const normalizedEmail = normalizeEmail(email);
  const user = await findUserByEmail(normalizedEmail);
  if (!user) return null;

  const validPassword = await verifyPassword(password, user.passwordHash);
  if (!validPassword) return null;

  return {
    id: user.id,
    email: user.email,
  };
}

export async function createSessionForUser(res: Response, userId: string) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  await createUserSession(userId, tokenHash, expiresAt);
  setSessionCookie(res, token, expiresAt);
}

export async function getAuthenticatedUser(
  req: Request,
): Promise<AuthenticatedUser | null> {
  const token = getCookie(req, SESSION_COOKIE_NAME);
  if (!token) return null;

  const session = await findUserBySessionTokenHash(hashSessionToken(token));
  if (!session || session.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  return {
    id: session.user.id,
    email: session.user.email,
  };
}

export async function clearSession(req: Request, res: Response) {
  const token = getCookie(req, SESSION_COOKIE_NAME);
  if (token) {
    await deleteUserSession(hashSessionToken(token));
  }
  clearSessionCookie(res);
}

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("base64url");
  return new Promise<string>((resolve, reject) => {
    crypto.pbkdf2(
      password,
      salt,
      PASSWORD_ITERATIONS,
      PASSWORD_KEYLEN,
      PASSWORD_DIGEST,
      (err, derivedKey) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(
          [
            "pbkdf2",
            PASSWORD_DIGEST,
            PASSWORD_ITERATIONS,
            salt,
            derivedKey.toString("base64url"),
          ].join("$"),
        );
      },
    );
  });
}

function verifyPassword(password: string, storedHash: string) {
  const [algorithm, digest, iterationsValue, salt, encodedHash] =
    storedHash.split("$");
  if (algorithm !== "pbkdf2" || !digest || !iterationsValue || !salt) {
    return false;
  }

  const iterations = Number(iterationsValue);
  if (!Number.isInteger(iterations) || iterations <= 0) return false;

  const expected = Buffer.from(encodedHash, "base64url");
  return new Promise<boolean>((resolve, reject) => {
    crypto.pbkdf2(
      password,
      salt,
      iterations,
      expected.length,
      digest,
      (err, derivedKey) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(
          expected.length === derivedKey.length &&
            crypto.timingSafeEqual(expected, derivedKey),
        );
      },
    );
  });
}

function hashSessionToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

function setSessionCookie(res: Response, token: string, expiresAt: Date) {
  const secure = process.env.AUTH_COOKIE_SECURE === "1";
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    expires: expiresAt,
    path: "/",
  });
}

function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.AUTH_COOKIE_SECURE === "1",
    path: "/",
  });
}

function getCookie(req: Request, name: string) {
  const header = req.headers.cookie;
  if (!header) return null;

  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }

  return null;
}
