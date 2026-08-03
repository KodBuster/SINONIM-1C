/**
 * AdvantShop admin CSV 2.0 import (Товары → Импорт данных).
 * Matches by «Артикул модификации», supports OnlyUpdateProducts.
 *
 * productActionType — действие с товарами, которых нет в CSV:
 *   0 none | 1 delete | 2 deactivate | 3 zero stock
 */
export async function importCsvViaAdmin({
  adminBaseUrl,
  email,
  password,
  csvBuffer,
  filename = "import.csv",
  encoding = "UTF-8",
  onlyUpdateProducts = true,
  productActionType = "3",
  pollMs = 1500,
  pollTimeoutMs = 10 * 60 * 1000,
  log = console.log,
}) {
  const root = adminBaseUrl.replace(/\/$/, "");
  const apiBase = `${root}/adminv3`;
  const jar = new Map();
  const actionType = normalizeProductActionType(productActionType);

  await adminLogin(root, email, password, jar);
  const token = await fetchAntiforgeryToken(apiBase, jar);

  await uploadCsvFile(apiBase, jar, token, csvBuffer, filename);
  log("[sync] admin: CSV uploaded");
  log(
    `[sync] admin: missing-in-file action=${describeProductAction(actionType)} (${actionType})`,
  );

  const settings = {
    Encoding: encoding === "windows-1251" || encoding === "win1251" ? "Windows-1251" : "UTF-8",
    ColumnSeparator: ";",
    PropertySeparator: ";",
    PropertyValueSeparator: ":",
    HaveHeader: true,
    csvV2: "true",
    OnlyUpdateProducts: onlyUpdateProducts,
    ProductActionType: actionType,
    ImportRemainsType: "normal",
    UpdatePhotos: false,
    Enabled301Redirects: false,
    AddProductInParentCategory: false,
    selectedFields: [],
  };

  const fields = await postJson(apiBase, jar, token, "import/GetFieldsFromCsvFile", settings);
  if (!fields?.result || !fields?.obj) {
    throw new Error(
      `admin GetFieldsFromCsvFile failed: ${JSON.stringify(fields).slice(0, 400)}`,
    );
  }

  if (Array.isArray(fields.obj.SelectedFields) && fields.obj.SelectedFields.length) {
    settings.selectedFields = fields.obj.SelectedFields;
  } else {
    const all = fields.obj.AllFields || {};
    const nameToKey = Object.fromEntries(
      Object.entries(all).map(([k, v]) => [String(v).toLowerCase(), k]),
    );
    settings.selectedFields = (fields.obj.Headers || []).map(
      (h) => nameToKey[String(h).toLowerCase()] || "None",
    );
  }
  log(`[sync] admin: fields mapped → ${settings.selectedFields.join(", ")}`);

  const start = await postJson(apiBase, jar, token, "import/StartProductsImport", settings);
  if (!start?.result) {
    throw new Error(
      `admin StartProductsImport failed: ${(start?.errors || []).join("; ") || JSON.stringify(start)}`,
    );
  }
  log("[sync] admin: import started");

  const stats = await waitForImport(apiBase, jar, token, {
    pollMs,
    pollTimeoutMs,
    log,
  });

  const logText = await fetchImportLogFile(apiBase, jar, token);
  const parsed = parseImportLog(logText);
  return { ...stats, logText, ...parsed };
}

function mergeCookies(jar, res) {
  const raw =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [];
  const list = raw.length
    ? raw
    : res.headers.get("set-cookie")
      ? [res.headers.get("set-cookie")]
      : [];
  for (const c of list) {
    jar.set(String(c).split("=")[0], String(c).split(";")[0]);
  }
}

function cookieHeader(jar) {
  return [...jar.values()].join("; ");
}

async function adminLogin(root, email, password, jar) {
  const loginUrl = `${root}/adminv2/login`;
  const page = await fetch(loginUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
  mergeCookies(jar, page);

  const res = await fetch(loginUrl, {
    method: "POST",
    redirect: "manual",
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(jar),
      Referer: loginUrl,
    },
    body: new URLSearchParams({ txtLogin: email, txtPassword: password }),
  });
  mergeCookies(jar, res);

  let loc = res.headers.get("location");
  if (!loc || /\/adminv2\/login/i.test(loc)) {
    throw new Error("AdvantShop admin login failed (check email/password)");
  }

  for (let i = 0; i < 8 && loc; i += 1) {
    const url = loc.startsWith("http") ? loc : new URL(loc, root).href;
    const r = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0", Cookie: cookieHeader(jar) },
    });
    mergeCookies(jar, r);
    loc = r.headers.get("location");
  }
}

async function fetchAntiforgeryToken(apiBase, jar) {
  const res = await fetch(`${apiBase}/import`, {
    headers: { "User-Agent": "Mozilla/5.0", Cookie: cookieHeader(jar) },
  });
  mergeCookies(jar, res);
  const html = await res.text();
  const token =
    html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i)?.[1] ||
    html.match(/value="([^"]+)"[^>]*name="__RequestVerificationToken"/i)?.[1];
  if (!token) throw new Error("AdvantShop antiforgery token not found on /adminv3/import");
  return token;
}

function authHeaders(jar, token) {
  return {
    "User-Agent": "Mozilla/5.0",
    Cookie: cookieHeader(jar),
    "X-Requested-With": "XMLHttpRequest",
    Accept: "application/json, text/plain, */*",
    __RequestVerificationToken: token,
  };
}

async function uploadCsvFile(apiBase, jar, token, csvBuffer, filename) {
  const form = new FormData();
  form.append(
    "file",
    new Blob([csvBuffer], { type: "text/csv" }),
    filename,
  );
  form.append("rnd", String(Math.random()));

  const res = await fetch(`${apiBase}/import/uploadCsvFile`, {
    method: "POST",
    headers: {
      ...authHeaders(jar, token),
      Referer: `${apiBase}/import`,
    },
    body: form,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`admin uploadCsvFile HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!(json.Result === true || json.result === true)) {
    throw new Error(`admin uploadCsvFile failed: ${json.Error || json.error || text.slice(0, 300)}`);
  }
}

async function postJson(apiBase, jar, token, path, data) {
  const res = await fetch(`${apiBase}/${path.replace(/^\//, "")}`, {
    method: "POST",
    headers: {
      ...authHeaders(jar, token),
      Referer: `${apiBase}/import`,
      "Content-Type": "application/json;charset=UTF-8",
    },
    body: JSON.stringify(data),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`admin ${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

async function waitForImport(apiBase, jar, token, { pollMs, pollTimeoutMs, log }) {
  const started = Date.now();
  let last = null;
  // give the job a moment to flip IsRun
  await new Promise((r) => setTimeout(r, 500));

  while (Date.now() - started < pollTimeoutMs) {
    const stats = await postJson(
      apiBase,
      jar,
      token,
      "ExportImportCommon/GetCommonStatistic",
      {},
    );
    last = stats;
    const pct = stats.ProcessedPercent ?? 0;
    log(
      `[sync] admin progress: ${pct}% add=${stats.Add ?? 0} update=${stats.Update ?? 0} error=${stats.Error ?? 0}`,
    );
    if (stats.IsRun === false && (pct === 100 || (stats.Processed ?? 0) > 0)) {
      return stats;
    }
    if (stats.IsRun === false && Date.now() - started > 5000 && pct === 100) {
      return stats;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `admin import timeout after ${pollTimeoutMs}ms; last=${JSON.stringify(last).slice(0, 400)}`,
  );
}

async function fetchImportLogFile(apiBase, jar, token) {
  const res = await fetch(`${apiBase}/ExportImportCommon/getlogfile`, {
    headers: {
      ...authHeaders(jar, token),
      Referer: `${apiBase}/import`,
    },
  });
  if (!res.ok) {
    throw new Error(`admin getlogfile HTTP ${res.status}`);
  }
  return await res.text();
}

/** @param {string|number} value */
export function normalizeProductActionType(value) {
  const raw = String(value ?? "3").trim().toLowerCase();
  const map = {
    "0": "0",
    none: "0",
    nothing: "0",
    "1": "1",
    delete: "1",
    remove: "1",
    "2": "2",
    deactivate: "2",
    disable: "2",
    "3": "3",
    zero: "3",
    zero_stock: "3",
    "zero-stock": "3",
    nulling: "3",
  };
  if (!(raw in map)) {
    throw new Error(
      `Unknown ProductActionType "${value}" (use none|delete|deactivate|zero or 0..3)`,
    );
  }
  return map[raw];
}

export function describeProductAction(type) {
  return (
    {
      0: "none",
      1: "delete",
      2: "deactivate",
      3: "zero-stock",
    }[String(type)] || String(type)
  );
}

function pickMetaLabel(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string" || typeof value === "number") {
    const s = String(value).trim();
    return s === "----" || s === "—" ? "" : s;
  }
  if (typeof value === "object") {
    const nested =
      value.Name ?? value.name ?? value.SizeName ?? value.ColorName ?? value.Value;
    return pickMetaLabel(nested);
  }
  return "";
}

/**
 * Читает текущие Размер/Цвет модификаций из админки AdvantShop.
 * Нужно, чтобы CSV-импорт stocks не затирал размеры (колонка «Размер» обязана
 * присутствовать со значениями из карточки — суффикс OfferArtNo размером не является).
 *
 * @returns {Promise<Map<string, { size: string, color: string, productId: number }>>}
 */
export async function fetchOfferSizeColorMap({
  adminBaseUrl,
  email,
  password,
  parentArtNos = [],
  log = console.log,
}) {
  const root = adminBaseUrl.replace(/\/$/, "");
  const apiBase = `${root}/adminv3`;
  const jar = new Map();
  const wantedParents = new Set(
    parentArtNos.map((a) => String(a || "").trim().toLowerCase()).filter(Boolean),
  );

  await adminLogin(root, email, password, jar);
  const token = await fetchAntiforgeryToken(apiBase, jar);

  const catalogUrl =
    `${apiBase}/catalog/getcatalog?ItemsPerPage=999999&Page=1` +
    `&categoryId=0&search=&showMethod=AllProducts`;
  const catalogRes = await fetch(catalogUrl, {
    headers: {
      ...authHeaders(jar, token),
      Referer: `${apiBase}/catalog?showMethod=AllProducts`,
    },
  });
  const catalogText = await catalogRes.text();
  let catalogJson;
  try {
    catalogJson = JSON.parse(catalogText);
  } catch {
    throw new Error(
      `admin getcatalog HTTP ${catalogRes.status}: ${catalogText.slice(0, 300)}`,
    );
  }
  const products = catalogJson?.DataItems || catalogJson?.obj?.DataItems || [];
  log(`[sync] admin catalog: ${products.length} product(s)`);

  /** @type {Map<string, number>} */
  const productIdByArt = new Map();
  for (const product of products) {
    const art = String(
      product.ProductArtNo ?? product.ArtNo ?? product.artNo ?? "",
    ).trim();
    const id = Number(product.ProductId ?? product.productId ?? 0);
    if (!art || !id) continue;
    const key = art.toLowerCase();
    if (wantedParents.size && !wantedParents.has(key)) continue;
    productIdByArt.set(key, id);
  }

  if (wantedParents.size && productIdByArt.size === 0) {
    log("[sync] admin: no catalog products matched stocks ArtNo list");
  }

  /** @type {Map<string, { size: string, color: string, productId: number }>} */
  const offerMap = new Map();
  const productIds = [...new Set(productIdByArt.values())];

  for (const productId of productIds) {
    const offersUrl =
      `${apiBase}/product/getOffers?ItemsPerPage=999&Page=1&ProductId=${productId}`;
    const offersRes = await fetch(offersUrl, {
      headers: {
        ...authHeaders(jar, token),
        Referer: `${apiBase}/product/edit/${productId}`,
      },
    });
    const offersText = await offersRes.text();
    let offersJson;
    try {
      offersJson = JSON.parse(offersText);
    } catch {
      log(
        `[sync] admin getOffers productId=${productId} HTTP ${offersRes.status}: ${offersText.slice(0, 120)}`,
      );
      continue;
    }
    const offers = offersJson?.DataItems || offersJson?.obj?.DataItems || [];
    for (const offer of offers) {
      const offerArt = String(offer.ArtNo ?? offer.artNo ?? "").trim();
      if (!offerArt) continue;
      offerMap.set(offerArt.toLowerCase(), {
        size: pickMetaLabel(offer.Size ?? offer.size ?? offer.SizeName),
        color: pickMetaLabel(offer.Color ?? offer.color ?? offer.ColorName),
        productId,
      });
    }
  }

  log(`[sync] admin offers meta: ${offerMap.size} offer(s) with size/color`);
  return offerMap;
}

/**
 * AdvantShop log lines look like:
 *   Товар обновлен: 802-03159
 *   Товар добавлен: ...
 *   Остаток обнулен: ...
 */
export function parseImportLog(logText) {
  const updated = [];
  const added = [];
  const zeroed = [];
  const errors = [];
  let zeroStockActionRan = false;
  for (const raw of String(logText || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^Обнулить остатки$/i.test(line)) {
      zeroStockActionRan = true;
      continue;
    }
    let m = line.match(/^Товар обновлен:\s*(.+)$/i);
    if (m) {
      updated.push(m[1].trim());
      continue;
    }
    m = line.match(/^Товар добавлен:\s*(.+)$/i);
    if (m) {
      added.push(m[1].trim());
      continue;
    }
    m = line.match(/^(?:Остаток обнулен|Количество обнулено|Обнулен остаток):\s*(.+)$/i);
    if (m) {
      zeroed.push(m[1].trim());
      continue;
    }
    if (/обнул/i.test(line) && /:\s*\S+/.test(line)) {
      const art = line.split(":").slice(1).join(":").trim();
      if (art) zeroed.push(art);
      continue;
    }
    if (/ошибк|error|не найден/i.test(line) && !/^Конец|^Начало|^Запуск|^Окончание/i.test(line)) {
      errors.push(line);
    }
  }
  return {
    updatedArts: updated,
    addedArts: added,
    zeroedArts: zeroed,
    zeroStockActionRan,
    errorLines: errors,
  };
}

/**
 * Match CSV rows against arts from AdvantShop import log.
 * Log usually lists parent ArtNo; we also accept OfferArtNo.
 */
export function classifyImportArts(rows, updatedArts, addedArts = []) {
  const hit = new Set(
    [...(updatedArts || []), ...(addedArts || [])].map((a) => String(a).trim()).filter(Boolean),
  );
  const updated = [];
  const notUpdated = [];
  for (const row of rows || []) {
    const artNo = String(row.artNo || "").trim();
    const offer = String(row.offer || "").trim() || artNo;
    const label = offer || artNo;
    if (hit.has(offer) || hit.has(artNo)) {
      updated.push(label);
    } else {
      notUpdated.push(label);
    }
  }
  return { updated, notUpdated };
}
