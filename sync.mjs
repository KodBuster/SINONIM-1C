/**
 * 1С CSV (FTP) → AdvantShop `/api/1c/importproducts`
 *
 * Ожидаемые колонки в файле 1С (разделитель ; или ,):
 *   ArtNo;OfferArtNo;Amount;Price;Weight;Set
 *   (имена можно переименовать через env)
 *
 * AdvantShop URL берётся со страницы:
 *   Настройки → API → вкладка «1C» → «Импорт товаров»
 *   http(s)://shop.../api/1c/importproducts?apikey=...
 *
 * Использование:
 *   node scripts/sync-ftp-to-advantshop.mjs
 *   node scripts/sync-ftp-to-advantshop.mjs --dry-run
 *   node scripts/sync-ftp-to-advantshop.mjs --file ./tmp/stocks.csv
 *
 * Env (в .env.local или окружении):
 *   ADVANTSHOP_BASE_URL=https://shop.synonym-jewelry.ru
 *   ADVANTSHOP_SERVER_API_KEY=...
 *   # либо полный URL:
 *   # ADVANTSHOP_1C_IMPORT_URL=https://shop.../api/1c/importproducts?apikey=...
 *
 *   FTP_HOST=ftp.example.ru
 *   FTP_USER=...
 *   FTP_PASSWORD=...
 *   FTP_REMOTE_PATH=/sinonim/stocks.csv
 *   FTP_SECURE=false
 *
 *   # опционально
 *   SYNC_CSV_DELIMITER=;
 *   SYNC_SRC_ARTNO=ArtNo
 *   SYNC_SRC_OFFER=OfferArtNo
 *   SYNC_SRC_AMOUNT=Amount
 *   SYNC_SRC_PRICE=Price
 *   SYNC_SRC_WEIGHT=Weight
 *   SYNC_SRC_SET=Set
 *   # Выход для /api/1c/importproducts = CSV 1.0 MultiOffer (по умолчанию):
 *   #   ArtNo;MultiOffer
 *   #   802-02763;[802-02763-7:7::15635::2]
 *   # Ручной админ-импорт CSV 2.0 (Артикул;Артикул модификации;…;Свойство: Вес, гр.;Свойство: Set)
 *   # SYNC_OUT_FORMAT=multioffer|columns|csv2
 *   SYNC_SKIP_IF_UNCHANGED=true
 *   SYNC_WORK_DIR=./tmp/1c-sync
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import iconv from "iconv-lite";
import {
  classifyImportArts,
  importCsvViaAdmin,
  syncStocksViaAdminOffers,
  buildSetPropertyCsv,
} from "./admin-import.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;

loadEnvFile(join(root, ".env.local"));
loadEnvFile(join(root, ".env"));

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const localFileArg = getArgValue("--file");

const config = {
  baseUrl: (process.env.ADVANTSHOP_BASE_URL || "").replace(/\/$/, ""),
  apiKey:
    process.env.ADVANTSHOP_SERVER_API_KEY ||
    process.env.ADVANTSHOP_API_KEY ||
    "",
  importUrl: process.env.ADVANTSHOP_1C_IMPORT_URL || "",
  ftp: {
    host: process.env.FTP_HOST || "",
    user: process.env.FTP_USER || "",
    password: process.env.FTP_PASSWORD || "",
    remotePath: process.env.FTP_REMOTE_PATH || "/stocks.csv",
    secure: String(process.env.FTP_SECURE || "false").toLowerCase() === "true",
    // пустой секрет FTP_PORT="" даёт Number("")===0 — ломает connect
    port: (() => {
      const n = Number(process.env.FTP_PORT);
      return Number.isFinite(n) && n > 0 ? n : 21;
    })(),
  },
  delimiter: process.env.SYNC_CSV_DELIMITER || "",
  src: {
    artNo: process.env.SYNC_SRC_ARTNO || "ArtNo",
    offer: process.env.SYNC_SRC_OFFER || "OfferArtNo",
    amount: process.env.SYNC_SRC_AMOUNT || "Amount",
    price: process.env.SYNC_SRC_PRICE || "Price",
    weight: process.env.SYNC_SRC_WEIGHT || "Weight",
    set: process.env.SYNC_SRC_SET || "Set",
  },
  // offer-sku / multioffer / csv2 — см. transform. POST в importproducts по умолчанию ВЫКЛ:
  // этот endpoint создаёт товары и не обновляет модификации (проверено на каталоге Sinonim).
  outFormat: (process.env.SYNC_OUT_FORMAT || "csv2").toLowerCase(),
  // utf8 (с BOM) | windows-1251 — ручной образец Sinonim был UTF-8 BOM
  outEncoding: (process.env.SYNC_OUT_ENCODING || "utf8").toLowerCase(),
  maxRows: Number(process.env.SYNC_MAX_ROWS || 0) || 0,
  // admin = CSV 2.0 через админку (рабочий путь)
  // relay-github = только FTP → commit CSV в GitHub (Amvera); Actions потом делает admin
  // api = /api/1c/importproducts (ломает каталог)
  uploadMode: (process.env.SYNC_UPLOAD_MODE || "admin").toLowerCase(),
  githubRelay: {
    token: envTrim("SYNC_GITHUB_TOKEN") || envTrim("GITHUB_TOKEN"),
    repo: envTrim("SYNC_GITHUB_REPO") || "KodBuster/SINONIM-1C",
    path: envTrim("SYNC_GITHUB_PATH") || "data/stocks-latest.csv",
    branch: envTrim("SYNC_GITHUB_BRANCH") || "main",
    // false: пусть срабатывает только push на data/stocks-latest.csv (без гонки cancel)
    triggerWorkflow:
      String(process.env.SYNC_GITHUB_TRIGGER_WORKFLOW || "false").toLowerCase() ===
      "true",
    workflowId:
      envTrim("SYNC_GITHUB_WORKFLOW_ID") || "sync-stocks.yml",
  },
  admin: {
    baseUrl: normalizeAdminBaseUrl(
      process.env.ADVANTSHOP_ADMIN_URL ||
        "https://my.advantshop.net/437286-kfbw",
    ),
    email: envTrim("ADVANTSHOP_ADMIN_EMAIL"),
    password: envTrim("ADVANTSHOP_ADMIN_PASSWORD"),
    onlyUpdate:
      String(process.env.SYNC_ADMIN_ONLY_UPDATE || "true").toLowerCase() !==
      "false",
    // none|delete|deactivate|zero — товары магазина, которых нет в CSV из 1С
    missingAction: (process.env.SYNC_ADMIN_MISSING_ACTION || "zero").toLowerCase(),
  },
  postEnabled: (() => {
    const raw = process.env.SYNC_POST_ENABLED;
    if (raw !== undefined && String(raw).trim() !== "") {
      return String(raw).trim().toLowerCase() === "true";
    }
    return Boolean(envTrim("ADVANTSHOP_ADMIN_PASSWORD"));
  })(),
  abortOnCreate:
    String(process.env.SYNC_ABORT_ON_CREATE || "true").toLowerCase() !==
    "false",
  dst: {
    artNo: process.env.SYNC_DST_ARTNO || "ArtNo",
    offer: process.env.SYNC_DST_OFFER || "MultiOffer",
    amount: process.env.SYNC_DST_AMOUNT || "Amount",
    price: process.env.SYNC_DST_PRICE || "Price",
  },
  skipIfUnchanged:
    String(process.env.SYNC_SKIP_IF_UNCHANGED || "true").toLowerCase() !==
    "false",
  workDir: resolve(root, process.env.SYNC_WORK_DIR || "./tmp/1c-sync"),
};

function envTrim(name) {
  const v = process.env[name];
  if (v === undefined || v === null) return "";
  return String(v).trim();
}

/** Корень магазина на my.advantshop.net, без /adminv2/login?... */
function normalizeAdminBaseUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return "https://my.advantshop.net/437286-kfbw";
  try {
    const u = new URL(s);
    // часто копируют адрес из браузера: .../adminv2/login?frompage=closed
    u.hash = "";
    u.search = "";
    let path = u.pathname.replace(/\/+$/, "");
    path = path.replace(/\/adminv\d+(?:\/.*)?$/i, "");
    path = path.replace(/\/login$/i, "");
    u.pathname = path || "/";
    return u.toString().replace(/\/$/, "");
  } catch {
    return s
      .replace(/\/adminv\d+\/login.*/i, "")
      .replace(/\/adminv\d+.*/i, "")
      .replace(/\/$/, "");
  }
}

function logAdminEnvDiagnostics() {
  const email = envTrim("ADVANTSHOP_ADMIN_EMAIL");
  const password = envTrim("ADVANTSHOP_ADMIN_PASSWORD");
  const keys = Object.keys(process.env)
    .filter((k) => /^ADVANTSHOP_/i.test(k) || /^SYNC_/i.test(k))
    .sort();
  console.log(
    `[sync] env: ADMIN_EMAIL=${email ? "set" : "MISSING"}` +
      ` ADMIN_PASSWORD=${password ? `set(len=${password.length})` : "MISSING"}` +
      ` ADMIN_URL=${envTrim("ADVANTSHOP_ADMIN_URL") ? "set" : "default"}` +
      ` ADMIN_BASE=${config.admin.baseUrl}` +
      ` UPLOAD_MODE=${process.env.SYNC_UPLOAD_MODE || "admin(default)"}` +
      ` POST_ENABLED=${process.env.SYNC_POST_ENABLED ?? "(auto)"}` +
      ` ENCODING=${process.env.SYNC_OUT_ENCODING || "utf8(default)"}`,
  );
  console.log(`[sync] env keys: ${keys.join(", ") || "(none)"}`);
}

main().catch((error) => {
  const cause = error?.cause;
  const causeMsg =
    cause instanceof Error
      ? `${cause.name}: ${cause.message}`
      : cause
        ? String(cause)
        : "";
  console.error(
    "[sync] fatal:",
    error?.message || error,
    causeMsg ? `| cause: ${causeMsg}` : "",
  );
  if (error?.stack) console.error(error.stack);
  process.exit(1);
});

async function probeAdminConnectivity() {
  const host = (() => {
    try {
      return new URL(config.admin.baseUrl).hostname;
    } catch {
      return "my.advantshop.net";
    }
  })();
  try {
    const { lookup } = await import("node:dns/promises");
    const v4 = await lookup(host, { family: 4 }).catch(() => null);
    const v6 = await lookup(host, { family: 6 }).catch(() => null);
    console.log(
      `[sync] DNS ${host}:` +
        ` A=${v4?.address || "-"}` +
        ` AAAA=${v6?.address || "-"}`,
    );
  } catch (error) {
    console.warn(`[sync] DNS probe failed: ${error?.message || error}`);
  }

  const loginUrl = `${config.admin.baseUrl}/adminv2/login`;
  const timeoutMs = Number(process.env.SYNC_ADMIN_FETCH_TIMEOUT_MS || 60_000);
  const started = Date.now();
  try {
    const { Agent } = await import("undici");
    const dispatcher = new Agent({
      connect: { timeout: timeoutMs, family: 4 },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    const res = await fetch(loginUrl, {
      method: "GET",
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0" },
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    });
    console.log(
      `[sync] admin probe (IPv4) ${loginUrl} → HTTP ${res.status} in ${Date.now() - started}ms`,
    );
  } catch (error) {
    const cause = error?.cause;
    const causeMsg =
      cause instanceof Error
        ? `${cause.name}: ${cause.message}`
        : cause
          ? String(cause)
          : error?.message || String(error);
    console.error(
      `[sync] admin probe FAILED ${loginUrl} in ${Date.now() - started}ms: ${causeMsg}`,
    );
    console.error(
      "[sync] Host не достучался до AdvantShop admin (TCP/443). " +
        "DNS ок, но connect таймаут → egress/firewall. " +
        "Amvera: попросите открыть outbound 443 к 85.92.118.90. " +
        "Обход: GitHub Actions workflow sync-stocks или npm run sync с ПК.",
    );
  }
}

async function main() {
  logAdminEnvDiagnostics();
  mkdirSync(config.workDir, { recursive: true });

  // Amvera: FTP ок, AdvantShop:443 нет. GitHub Actions: наоборот.
  // relay-github только качает FTP и кладёт CSV в репозиторий.
  if (config.uploadMode === "relay-github") {
    const sourcePath = join(config.workDir, "from-ftp.csv");
    assertFtpConfig();
    await downloadFromFtp(sourcePath);
    const raw = readFileSync(sourcePath);
    await relayCsvToGithub(raw);
    console.log("[sync] relay-github done");
    return;
  }

  if (config.uploadMode === "admin") {
    await probeAdminConnectivity();
  }

  const sourcePath = localFileArg
    ? resolve(localFileArg)
    : join(config.workDir, "from-ftp.csv");

  if (localFileArg) {
    if (!existsSync(sourcePath)) {
      throw new Error(`Local file not found: ${sourcePath}`);
    }
    console.log(`[sync] using local file: ${sourcePath}`);
  } else {
    assertFtpConfig();
    await downloadFromFtp(sourcePath);
  }

  const raw = readFileSync(sourcePath);
  const text = decodeCsvBuffer(raw);
  const hash = sha1(text);
  const hashPath = join(config.workDir, "last-hash.txt");

  if (config.skipIfUnchanged && existsSync(hashPath)) {
    const prev = readFileSync(hashPath, "utf8").trim();
    if (prev === hash) {
      console.log("[sync] file unchanged, skip import");
      return;
    }
  }

  const { csv: baseCsv, rows: syncRows } = transformToAdvantShopCsv(text);
  const outPath = join(config.workDir, "advantshop-import.csv");
  // Keep a CSV snapshot for debugging; admin mode no longer imports it for offers.
  writeFileSync(outPath, encodeCsvOutput(baseCsv));
  console.log(`[sync] prepared snapshot CSV: ${outPath}`);
  console.log(`[sync] encoding: ${config.outEncoding}`);
  console.log(`[sync] rows: ${syncRows.length}`);

  if (dryRun || !config.postEnabled) {
    console.log(
      dryRun
        ? "[sync] dry-run: will use admin updateOffer (no CSV offer import)"
        : "[sync] upload skipped (set ADVANTSHOP_ADMIN_PASSWORD or SYNC_POST_ENABLED=true)",
    );
  }

  if (config.uploadMode === "admin") {
    if (!config.admin.email || !config.admin.password) {
      throw new Error(
        "Admin upload requires ADVANTSHOP_ADMIN_EMAIL and ADVANTSHOP_ADMIN_PASSWORD " +
          `(email=${config.admin.email ? "ok" : "empty"}, password=${config.admin.password ? "ok" : "empty"}). ` +
          "Проверьте, что переменные в ЭТОМ Cron Job (Варшава), этап Запуск, и контейнеры перезапущены.",
      );
    }

    let missingAction = config.admin.missingAction;
    if (config.maxRows > 0 && missingAction !== "none" && missingAction !== "0") {
      console.warn(
        `[sync] SYNC_MAX_ROWS=${config.maxRows}: missing-in-file action forced to none ` +
          `(иначе обнулится почти весь каталог)`,
      );
      missingAction = "none";
    }

    console.log(
      `[sync] admin offer sync via ${config.admin.baseUrl}/adminv3/product/updateOffer`,
    );
    const stats = await syncStocksViaAdminOffers({
      adminBaseUrl: config.admin.baseUrl,
      email: config.admin.email,
      password: config.admin.password,
      rows: syncRows,
      zeroMissing: missingAction === "zero" || missingAction === "3" || missingAction === "zero_stock" || missingAction === "zero-stock",
      dryRun: dryRun || !config.postEnabled,
      log: console.log,
    });

    // Set — отдельный CSV только со свойством, без размеров/модификаций/цены.
    if (
      !dryRun &&
      config.postEnabled &&
      Array.isArray(stats.setRows) &&
      stats.setRows.length
    ) {
      const setCsv = buildSetPropertyCsv(stats.setRows);
      const setPath = join(config.workDir, "advantshop-set-only.csv");
      writeFileSync(setPath, encodeCsvOutput(setCsv));
      console.log(
        `[sync] importing Set property for ${stats.setRows.length} product(s) (no sizes/offers)`,
      );
      try {
        const setStats = await importCsvViaAdmin({
          adminBaseUrl: config.admin.baseUrl,
          email: config.admin.email,
          password: config.admin.password,
          csvBuffer: encodeCsvOutput(setCsv),
          filename: "stocks-set-only.csv",
          encoding: config.outEncoding,
          onlyUpdateProducts: true,
          productActionType: "none",
          log: console.log,
        });
        console.log(
          `[sync] Set import done: update=${setStats.Update || 0} error=${setStats.Error || 0}`,
        );
      } catch (error) {
        console.warn(
          `[sync] Set property import failed: ${error?.message || error}`,
        );
      }
    }

    writeFileSync(
      join(config.workDir, "last-response.txt"),
      JSON.stringify(
        {
          Update: stats.Update,
          Error: stats.Error,
          updatedArts: stats.updatedArts,
          zeroedArts: stats.zeroedArts,
          notFoundArts: stats.notFoundArts,
          errorLines: stats.errorLines,
        },
        null,
        2,
      ),
      "utf8",
    );

    console.log(
      `[sync] admin done: update=${stats.Update || 0} zeroed=${(stats.zeroedArts || []).length} error=${stats.Error || 0}`,
    );
    logArtResults(syncRows, {
      updatedArts: stats.updatedArts,
      zeroedArts: stats.zeroedArts,
      errorLines: stats.errorLines,
    });
    if ((stats.zeroedArts || []).length) {
      console.log(
        `[sync] обнулены остатки (${stats.zeroedArts.length}): ${stats.zeroedArts.join(", ")}`,
      );
    }
    if ((stats.errorLines || []).length) {
      console.warn(`[sync] admin reported ${stats.errorLines.length} error(s)`);
    }

    if (dryRun || !config.postEnabled) {
      return;
    }
  } else {
    if (dryRun || !config.postEnabled) {
      console.log(baseCsv.split(/\r?\n/).slice(0, 6).join("\n"));
      return;
    }
    const importUrl = resolveImportUrl();
    console.log(`[sync] posting to: ${maskUrl(importUrl)}`);
    const responseText = await postCsvToAdvantShop(
      importUrl,
      encodeCsvOutput(baseCsv),
    );
    writeFileSync(join(config.workDir, "last-response.txt"), responseText, "utf8");
    console.log("[sync] AdvantShop response:");
    console.log(responseText.slice(0, 2000) || "(empty)");

    const added = (responseText.match(/Товар добавлен/gi) || []).length;
    const updated = (responseText.match(/Товар обновлен/gi) || []).length;
    if (added) {
      console.error(
        `[sync] FATAL: AdvantShop created ${added} new product(s)` +
          (updated ? `, updated ${updated}` : "") +
          ". /api/1c/importproducts does not match modification ArtNo. Aborting.",
      );
      if (config.abortOnCreate) process.exit(1);
    }
  }

  writeFileSync(hashPath, hash, "utf8");
  console.log("[sync] done");
}

function assertFtpConfig() {
  const missing = [];
  if (!config.ftp.host) missing.push("FTP_HOST");
  if (!config.ftp.user) missing.push("FTP_USER");
  if (!config.ftp.password) missing.push("FTP_PASSWORD");
  if (missing.length) {
    throw new Error(
      `Missing FTP env: ${missing.join(", ")}. Or pass --file ./path.csv`,
    );
  }
}

async function downloadFromFtp(destPath) {
  let Client;
  try {
    ({ Client } = await import("basic-ftp"));
  } catch {
    throw new Error(
      'Package "basic-ftp" is required. Run: npm install basic-ftp',
    );
  }

  const client = new Client(60_000);
  client.ftp.verbose =
    String(process.env.FTP_VERBOSE || "").toLowerCase() === "true";

  try {
    console.log(
      `[sync] FTP connect ${config.ftp.host}:${config.ftp.port} → ${config.ftp.remotePath}`,
    );
    await client.access({
      host: config.ftp.host,
      port: config.ftp.port,
      user: config.ftp.user,
      password: config.ftp.password,
      secure: config.ftp.secure,
    });
    await client.downloadTo(destPath, config.ftp.remotePath);
  } catch (error) {
    throw new Error(`FTP download failed: ${error?.message || error}`);
  } finally {
    client.close();
  }

  console.log(`[sync] downloaded → ${destPath}`);
}

async function relayCsvToGithub(rawBuffer) {
  const { token, repo, path, branch, triggerWorkflow, workflowId } =
    config.githubRelay;
  if (!token) {
    throw new Error(
      "relay-github requires SYNC_GITHUB_TOKEN (PAT: Contents write + Actions write)",
    );
  }
  const contentB64 = Buffer.from(rawBuffer).toString("base64");
  const hash = sha1(Buffer.isBuffer(rawBuffer) ? rawBuffer.toString("utf8") : String(rawBuffer));
  const apiBase = `https://api.github.com/repos/${repo}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "sinonim-1c-cron-relay",
  };

  const getUrl = `${apiBase}/contents/${path.replace(/^\//, "")}?ref=${encodeURIComponent(branch)}`;
  const existingRes = await fetch(getUrl, { headers });
  let sha;
  if (existingRes.status === 200) {
    const existing = await existingRes.json();
    sha = existing.sha;
    const prevRaw = Buffer.from(existing.content.replace(/\n/g, ""), "base64").toString("utf8");
    if (config.skipIfUnchanged && sha1(prevRaw) === hash) {
      console.log(`[sync] github ${repo}/${path}: unchanged, skip commit`);
      return { skipped: true };
    }
  } else if (existingRes.status !== 404) {
    const text = await existingRes.text();
    throw new Error(
      `GitHub GET contents failed HTTP ${existingRes.status}: ${text.slice(0, 300)}`,
    );
  }

  const putRes = await fetch(`${apiBase}/contents/${path.replace(/^\//, "")}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `chore: stocks.csv from FTP (${hash.slice(0, 8)})`,
      content: contentB64,
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!putRes.ok) {
    const text = await putRes.text();
    throw new Error(
      `GitHub PUT contents failed HTTP ${putRes.status}: ${text.slice(0, 400)}`,
    );
  }
  console.log(`[sync] github uploaded → ${repo}/${path} @ ${branch}`);

  if (triggerWorkflow) {
    const wfRes = await fetch(
      `${apiBase}/actions/workflows/${workflowId}/dispatches`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ ref: branch }),
      },
    );
    if (!wfRes.ok && wfRes.status !== 204) {
      const text = await wfRes.text();
      console.warn(
        `[sync] workflow_dispatch failed HTTP ${wfRes.status}: ${text.slice(0, 300)}`,
      );
    } else {
      console.log(`[sync] triggered workflow ${workflowId}`);
    }
  }

  return { skipped: false };
}

function resolveImportUrl() {
  if (config.importUrl) return config.importUrl;
  if (!config.baseUrl) {
    throw new Error("Set ADVANTSHOP_1C_IMPORT_URL or ADVANTSHOP_BASE_URL");
  }
  if (!config.apiKey) {
    throw new Error("Set ADVANTSHOP_SERVER_API_KEY (or ADVANTSHOP_1C_IMPORT_URL with apikey)");
  }
  const url = new URL(`${config.baseUrl}/api/1c/importproducts`);
  url.searchParams.set("apikey", config.apiKey);
  return url.toString();
}

async function postCsvToAdvantShop(importUrl, csvBody) {
  const mode = (process.env.SYNC_POST_MODE || "multipart").toLowerCase();
  const isWin1251 = config.outEncoding.includes("1251");
  const charset = isWin1251 ? "windows-1251" : "utf-8";
  const buf = Buffer.isBuffer(csvBody) ? csvBody : encodeCsvOutput(String(csvBody));

  /** @type {RequestInit} */
  let init;
  if (mode === "raw") {
    init = {
      method: "POST",
      headers: {
        "Content-Type": `text/csv; charset=${charset}`,
      },
      body: buf,
    };
  } else {
    const form = new FormData();
    form.append(
      "file",
      new Blob([buf], { type: `text/csv; charset=${charset}` }),
      "import.csv",
    );
    init = { method: "POST", body: form };
  }

  const response = await fetch(importUrl, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`AdvantShop HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return text;
}

/** @param {string} csvText */
function encodeCsvOutput(csvText) {
  const enc = config.outEncoding.replace(/_/g, "-");
  if (enc === "windows-1251" || enc === "cp1251" || enc === "win1251") {
    // без BOM — типично для ANSI/1251 в Excel/AdvantShop
    return iconv.encode(csvText.replace(/^\uFEFF/, ""), "win1251");
  }
  // utf8 с BOM
  const withBom = csvText.startsWith("\uFEFF") ? csvText : `\uFEFF${csvText}`;
  return Buffer.from(withBom, "utf8");
}

function transformToAdvantShopCsv(sourceText) {
  const delimiter = config.delimiter || detectDelimiter(sourceText);
  const lines = sourceText
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    throw new Error("CSV is empty or has no data rows");
  }

  const header = parseCsvLine(lines[0], delimiter);
  const idx = {
    artNo: findColumnIndex(header, config.src.artNo),
    offer: findColumnIndex(header, config.src.offer),
    amount: findColumnIndex(header, config.src.amount),
    price: findColumnIndex(header, config.src.price),
    weight: findColumnIndex(header, config.src.weight),
    set: findColumnIndex(header, config.src.set),
  };

  for (const key of ["artNo", "offer", "amount", "price"]) {
    if (idx[key] < 0) {
      throw new Error(
        `Column "${config.src[key]}" not found. Header: ${header.join(" | ")}`,
      );
    }
  }

  /** @type {{ artNo: string, offer: string, amount: string, price: string, weight: string, set: string }[]} */
  const rawRows = [];
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line, delimiter);
    const artNo = (cols[idx.artNo] || "").trim();
    const offer = (cols[idx.offer] || "").trim() || artNo;
    const amount = normalizeNumber(cols[idx.amount]);
    const price = normalizeNumber(cols[idx.price]);
    const weight =
      idx.weight >= 0 ? String(cols[idx.weight] ?? "").trim() : "";
    const set = idx.set >= 0 ? String(cols[idx.set] ?? "").trim() : "";
    if (!artNo) continue;
    rawRows.push({ artNo, offer, amount, price, weight, set });
  }

  const { rows, duplicateKeys } = dedupeStockRows(rawRows);

  if (!rows.length) {
    throw new Error("No valid data rows after transform");
  }

  if (duplicateKeys.length) {
    console.warn(
      `[sync] collapsed ${duplicateKeys.length} duplicate ArtNo+OfferArtNo: ${duplicateKeys.join(", ")}`,
    );
  }

  if (config.maxRows > 0) {
    rows.splice(config.maxRows);
    console.log(`[sync] SYNC_MAX_ROWS=${config.maxRows}, using ${rows.length} row(s)`);
  }

  let csv;
  let formatLabel;
  switch (config.outFormat) {
    case "multioffer":
      csv = buildMultiOfferCsv(rows);
      formatLabel = "multioffer (CSV 1.0 parent+offers)";
      break;
    case "csv2":
    case "columns":
      csv = buildCsv2Columns(rows);
      formatLabel = "csv2 (Артикул;Артикул модификации;…)";
      break;
    case "offer-sku":
    default:
      csv = buildOfferSkuCsv(rows);
      formatLabel = "offer-sku (ArtNo=модификация;Amount;Price)";
      break;
  }

  console.log(`[sync] out format: ${formatLabel}`);

  // BOM для utf8 добавляется в encodeCsvOutput
  return { csv, rows };
}

function logArtResults(rows, stats) {
  const fromLog = stats.updatedArts || [];
  const addedFromLog = stats.addedArts || [];
  const { updated, notUpdated } = classifyImportArts(
    rows,
    fromLog,
    addedFromLog,
  );

  if (!fromLog.length && Number(stats.Update || 0) > 0) {
    console.warn(
      "[sync] лог импорта AdvantShop пуст или без «Товар обновлен» — сверка артикулов неполная",
    );
  }

  console.log(
    `[sync] обновлены (${updated.length}): ${updated.length ? updated.join(", ") : "—"}`,
  );
  console.log(
    `[sync] не обновлены (${notUpdated.length}): ${
      notUpdated.length ? notUpdated.join(", ") : "—"
    }`,
  );
  if (addedFromLog.length) {
    console.log(
      `[sync] добавлены (${addedFromLog.length}): ${addedFromLog.join(", ")}`,
    );
  }
  const zeroed = stats.zeroedArts || [];
  if (zeroed.length) {
    console.log(
      `[sync] обнулены остатки (${zeroed.length}): ${zeroed.join(", ")}`,
    );
  } else if (stats.zeroStockActionRan) {
    console.log(
      "[sync] обнуление остатков: выполнено (AdvantShop не перечисляет артикулы)",
    );
  }
  if (stats.errorLines?.length) {
    console.warn(
      `[sync] ошибки в логе импорта (${stats.errorLines.length}):`,
    );
    for (const line of stats.errorLines) console.warn(`  ${line}`);
  }
}

/**
 * Ключ = артикул модификации (OfferArtNo), как в CSV 2.0 при обновлении.
 * Для /api/1c/importproducts: AdvantShop ищет оффер/товар по ArtNo.
 */
function buildOfferSkuCsv(rows) {
  const outRows = ["ArtNo;Amount;Price"];
  for (const row of rows) {
    outRows.push(
      [escapeCsv(row.offer), escapeCsv(row.amount), escapeCsv(row.price)].join(";"),
    );
  }
  return `${outRows.join("\r\n")}\r\n`;
}

/** CSV 2.0: цена/остаток/вес/Set + Размер/Цвет из карточки AdvantShop (чтобы не затереть). */
function buildCsv2Columns(rows) {
  const outRows = [
    "Артикул;Артикул модификации;Размер;Цвет;Количество;Цена;Свойство: Вес, гр.;Свойство: Set",
  ];
  for (const row of rows) {
    outRows.push(
      [
        escapeCsv(row.artNo),
        escapeCsv(row.offer),
        escapeCsv(row.size ?? ""),
        escapeCsv(row.color ?? ""),
        escapeCsv(row.amount),
        escapeCsv(row.price),
        escapeCsv(row.weight ?? ""),
        escapeCsv(row.set ?? ""),
      ].join(";"),
    );
  }
  return `${outRows.join("\r\n")}\r\n`;
}

/**
 * CSV 1.0: ArtNo родителя + MultiOffer
 * @see https://www.advantshop.net/help/pages/import-csv
 */
function buildMultiOfferCsv(rows) {
  /** @type {Map<string, string[]>} */
  const byArt = new Map();

  for (const row of rows) {
    const size = extractSizeFromOffer(row.artNo, row.offer);
    const cell = `[${row.offer}:${size}::${row.price}::${row.amount}]`;
    const list = byArt.get(row.artNo) || [];
    list.push(cell);
    byArt.set(row.artNo, list);
  }

  const outRows = ["ArtNo;MultiOffer"];
  for (const [artNo, offers] of byArt) {
    outRows.push(`${escapeCsv(artNo)};${escapeCsv(offers.join(","))}`);
  }
  return `${outRows.join("\r\n")}\r\n`;
}

/** 802-02763 + 802-02763-7 → "7"; если оффер = артикул → "" */
function extractSizeFromOffer(artNo, offer) {
  const prefix = `${artNo}-`;
  if (offer.startsWith(prefix) && offer.length > prefix.length) {
    return offer.slice(prefix.length);
  }
  return "";
}

function findColumnIndex(header, name) {
  const target = normalizeHeader(name);
  return header.findIndex((cell) => normalizeHeader(cell) === target);
}

function normalizeHeader(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function detectDelimiter(text) {
  const first = text.split(/\r?\n/).find((line) => line.trim()) || "";
  const semis = (first.match(/;/g) || []).length;
  const commas = (first.match(/,/g) || []).length;
  return semis >= commas ? ";" : ",";
}

function parseCsvLine(line, delimiter) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      result.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  result.push(current);
  return result;
}

function escapeCsv(value) {
  const s = String(value ?? "");
  if (/[;"\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function normalizeNumber(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s/g, "")
    .replace(",", ".");
}

/**
 * 1С иногда отдаёт несколько строк с одним ArtNo+OfferArtNo (разный Weight).
 * Повторный импорт таких дублей в AdvantShop сбивает «Главная» у модификации → цена 0 на витрине.
 * Оставляем последнюю строку по ключу (как в актуальном остатке AdvantShop).
 */
function dedupeStockRows(rows) {
  /** @type {Map<string, (typeof rows)[number]>} */
  const byKey = new Map();
  /** @type {Set<string>} */
  const seenDupes = new Set();

  for (const row of rows) {
    const key = `${row.artNo}\0${row.offer}`;
    if (byKey.has(key)) {
      seenDupes.add(`${row.artNo}/${row.offer}`);
    }
    byKey.set(key, row);
  }

  return {
    rows: [...byKey.values()],
    duplicateKeys: [...seenDupes],
  };
}

function countDataRows(csv) {
  return Math.max(0, csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/).length - 1);
}

function decodeCsvBuffer(buf) {
  // Пробуем utf8, иначе windows-1251 через TextDecoder если доступен
  const asUtf8 = buf.toString("utf8");
  if (!asUtf8.includes("�")) return asUtf8;
  try {
    return new TextDecoder("windows-1251").decode(buf);
  } catch {
    return asUtf8;
  }
}

function sha1(text) {
  return createHash("sha1").update(text).digest("hex");
}

function maskUrl(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has("apikey")) {
      u.searchParams.set("apikey", "***");
    }
    return u.toString();
  } catch {
    return url.replace(/apikey=[^&]+/i, "apikey=***");
  }
}

function getArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return "";
  return process.argv[idx + 1] || "";
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
