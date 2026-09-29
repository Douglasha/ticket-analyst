import crypto from "node:crypto";
import { loadSettings } from "./config.js";

const SESSION_DURATION_MS = 12 * 60 * 60 * 1000; // 12 horas
export const COOKIE_NAME = "ta_session";

function signHmac(data, secret) {
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

export function createSessionToken(userPayload, secret) {
  const payload = {
    username: userPayload.username,
    fullName: userPayload.fullName,
    firstName: userPayload.firstName,
    role: userPayload.role,
    authSource: userPayload.authSource,
    exp: Date.now() + SESSION_DURATION_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url");
  const signature = signHmac(encoded, secret);
  return `${encoded}.${signature}`;
}

export function verifySessionToken(token, secret) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return null;
  }
  const [encoded, sig] = token.split(".");
  if (!encoded || !sig) return null;

  const expectedSig = signHmac(encoded, secret);
  if (sig !== expectedSig) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));
    if (!payload.exp || Date.now() > payload.exp) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx > -1) {
      const k = pair.slice(0, idx).trim();
      const v = decodeURIComponent(pair.slice(idx + 1).trim());
      cookies[k] = v;
    }
  });
  return cookies;
}

export function extractUserFromRequest(req) {
  const settings = loadSettings();
  const secret = settings.auth_secret || "ticket-analyst-unimed-secret-key-2026";

  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    const verified = verifySessionToken(token, secret);
    if (verified) return verified;
  }

  const cookies = parseCookies(req.headers.cookie);
  if (cookies[COOKIE_NAME]) {
    const verified = verifySessionToken(cookies[COOKIE_NAME], secret);
    if (verified) return verified;
  }

  return null;
}

export function requireAuth(req, res, next) {
  const user = extractUserFromRequest(req);
  if (!user) {
    return res.status(401).json({
      authenticated: false,
      detail: "Sessão expirada ou não autenticada. Faça login para acessar o sistema.",
    });
  }
  req.user = user;
  next();
}

export async function authenticateUser(username, password, settings) {
  const cleanUser = String(username || "").trim();
  const cleanPass = String(password || "");

  if (!cleanUser || !cleanPass) {
    return {
      ok: false,
      status: 400,
      message: "Informe o usuário e a senha.",
    };
  }

  // 1. Verifica Admin Local de Contingência
  const localUser = String(settings.auth_local_user || "admin").trim();
  const localPass = String(settings.auth_local_password || "admin123");

  if (cleanUser.toLowerCase() === localUser.toLowerCase() && cleanPass === localPass) {
    return {
      ok: true,
      user: {
        username: localUser,
        fullName: "Administrador T.I.",
        firstName: "Admin",
        role: "Admin Local (Contingência)",
        authSource: "local",
      },
    };
  }

  // 2. Autenticação Direta na API REST do GLPI (Basic Auth + Validação de Perfil T.I.)
  let baseUrl = (settings.glpi_api_url || "").trim().replace(/\/+$/, "");
  if (baseUrl && !baseUrl.endsWith(".php") && !baseUrl.includes("/apirest.php")) {
    baseUrl = `${baseUrl}/apirest.php`;
  }

  if (!baseUrl || settings.glpi_demo_mode) {
    return {
      ok: false,
      status: 401,
      message: `Credenciais inválidas. Em Modo Simulação, utilize o usuário '${localUser}'.`,
    };
  }

  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const basicBase64 = Buffer.from(`${cleanUser}:${cleanPass}`, "utf-8").toString("base64");
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Basic ${basicBase64}`,
  };
  if (settings.glpi_app_token && settings.glpi_app_token.trim()) {
    headers["App-Token"] = settings.glpi_app_token.trim();
  }

  let res;
  try {
    res = await fetch(`${baseUrl}/initSession?get_full_session=true`, { headers });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      message: `Não foi possível contatar o servidor GLPI (${err.message}). Utilize o Admin Local de contingência.`,
    };
  }

  const rawBody = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    parsed = null;
  }

  if (!res.ok || !parsed?.session_token) {
    return {
      ok: false,
      status: 401,
      message: "Usuário ou senha do GLPI incorretos.",
    };
  }

  const sessionToken = parsed.session_token;
  const sessionObj = parsed.session || {};

  // Encerra imediatamente a sessão temporária de verificação no GLPI
  const killHeaders = {
    "Content-Type": "application/json",
    "Session-Token": sessionToken,
  };
  if (settings.glpi_app_token && settings.glpi_app_token.trim()) {
    killHeaders["App-Token"] = settings.glpi_app_token.trim();
  }

  try {
    // Valida os perfis do usuário no GLPI (Restrito à equipe de T.I.)
    let profileList = Object.values(sessionObj.glpiprofiles || {});
    if (profileList.length === 0) {
      const pRes = await fetch(`${baseUrl}/getMyProfiles`, { headers: killHeaders });
      if (pRes.ok) {
        const pData = await pRes.json();
        profileList = pData?.myprofiles || [];
      }
    }

    const techProfile =
      profileList.find((p) => /tecnologia|t\.i|suporte|tecnico/i.test(p.name || "")) ||
      profileList.find((p) => /super-admin|admin/i.test(p.name || ""));

    if (!techProfile) {
      return {
        ok: false,
        status: 403,
        message:
          "Acesso negado: seu usuário não possui perfil técnico de T.I. no GLPI (apenas Solicitante).",
      };
    }

    const firstRaw = String(sessionObj.glpifirstname || "").trim();
    const lastRaw = String(sessionObj.glpirealname || "").trim();
    const fullName =
      [firstRaw, lastRaw].filter(Boolean).join(" ").replace(/\s+/g, " ").trim() ||
      cleanUser;
    const firstName = (firstRaw || fullName).split(/\s+/)[0] || cleanUser;

    return {
      ok: true,
      user: {
        username: cleanUser,
        fullName,
        firstName,
        role: techProfile.name || "Analista T.I.",
        authSource: "glpi",
      },
    };
  } finally {
    try {
      await fetch(`${baseUrl}/killSession`, { headers: killHeaders });
    } catch {
      // ignora erro ao encerrar sessão temporária
    }
  }
}
