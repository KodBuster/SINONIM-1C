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

/** undici connect timeout по умолчанию 10s — с Amvera (особенно не-МСК) часто мало. */
const ADMIN_FETCH_TIMEOUT_MS = Number(
  process.env.SYNC_ADMIN_FETCH_TIMEOUT_MS || 60_000,
);

let adminDispatcherPromise;
async function getAdminDispatcher() {
  if (!adminDispatcherPromise) {
    adminDispatcherPromise = import("undici")
      .then(
        ({ Agent }) =>
          new Agent({
            // Amvera иногда резолвит AAAA, а IPv6 до AdvantShop не ходит → ConnectTimeout.
            connect: { timeout: ADMIN_FETCH_TIMEOUT_MS, family: 4 },
            headersTimeout: ADMIN_FETCH_TIMEOUT_MS,
            bodyTimeout: ADMIN_FETCH_TIMEOUT_MS,
          }),
      )
      .catch(() => null);
  }
  return adminDispatcherPromise;
}

async function adminFetch(url, init = {}) {
  const dispatcher = await getAdminDispatcher();
  try {
    return await fetch(url, {
      ...init,
      ...(dispatcher ? { dispatcher } : {}),
      signal: init.signal ?? AbortSignal.timeout(ADMIN_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const cause = error?.cause;
    const causeMsg =
      cause instanceof Error
        ? `${cause.name}: ${cause.message}`
        : cause
          ? String(cause)
          : error?.message || String(error);
    throw new Error(
      `AdvantShop admin unreachable (${url}): ${causeMsg}. ` +
        `Нужен outbound TCP/443 к my.advantshop.net (IPv4).`,
      { cause: error },
    );
  }
}

async function adminLogin(root, email, password, jar) {
  const loginUrl = `${root}/adminv2/login`;
  const page = await adminFetch(loginUrl, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  mergeCookies(jar, page);

  const res = await adminFetch(loginUrl, {
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
    const r = await adminFetch(url, {
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0", Cookie: cookieHeader(jar) },
    });
    mergeCookies(jar, r);
    loc = r.headers.get("location");
  }
}

async function fetchAntiforgeryToken(apiBase, jar) {
  const res = await adminFetch(`${apiBase}/import`, {
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

  const res = await adminFetch(`${apiBase}/import/uploadCsvFile`, {
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
  const res = await adminFetch(`${apiBase}/${path.replace(/^\//, "")}`, {
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
  const res = await adminFetch(`${apiBase}/ExportImportCommon/getlogfile`, {
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

function extractTokenFromHtml(html) {
  return (
    html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i)?.[1] ||
    html.match(/value="([^"]+)"[^>]*name="__RequestVerificationToken"/i)?.[1] ||
    ""
  );
}

async function fetchProductEditToken(apiBase, jar, productId) {
  const res = await adminFetch(`${apiBase}/product/edit/${productId}`, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Cookie: cookieHeader(jar),
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: `${apiBase}/catalog?showMethod=AllProducts`,
    },
  });
  mergeCookies(jar, res);
  const html = await res.text();
  const token = extractTokenFromHtml(html);
  if (!token) {
    throw new Error(`antiforgery token missing on product/edit/${productId}`);
  }
  return token;
}

/**
 * Обновляет остаток/цену/вес оффера через admin updateOffer.
 * Size/Color/Main не меняем — CSV-импорт их ломает.
 */
export async function syncStocksViaAdminOffers({
  adminBaseUrl,
  email,
  password,
  rows,
  zeroMissing = true,
  dryRun = false,
  log = console.log,
}) {
  const root = adminBaseUrl.replace(/\/$/, "");
  const apiBase = `${root}/adminv3`;
  const jar = new Map();

  await adminLogin(root, email, password, jar);
  const bootstrapToken = await fetchAntiforgeryToken(apiBase, jar);

  const catalogUrl =
    `${apiBase}/catalog/getcatalog?ItemsPerPage=999999&Page=1` +
    `&categoryId=0&search=&showMethod=AllProducts`;
  const catalogRes = await adminFetch(catalogUrl, {
    headers: {
      ...authHeaders(jar, bootstrapToken),
      Referer: `${apiBase}/catalog?showMethod=AllProducts`,
    },
  });
  const catalogJson = await catalogRes.json();
  const products = catalogJson?.DataItems || catalogJson?.obj?.DataItems || [];
  log(`[sync] admin catalog: ${products.length} product(s)`);

  /** @type {Map<number, any>} */
  const productById = new Map();
  /** @type {Map<string, number>} */
  const productIdByArt = new Map();
  for (const product of products) {
    const art = String(
      product.ProductArtNo ?? product.ArtNo ?? product.artNo ?? "",
    ).trim();
    const id = Number(product.ProductId ?? product.productId ?? 0);
    if (!art || !id) continue;
    productById.set(id, product);
    productIdByArt.set(art.toLowerCase(), id);
  }

  /** @type {Map<string, { productId: number, offer: any }>} */
  const offerByArt = new Map();
  /** @type {Map<number, any[]>} */
  const offersByProduct = new Map();

  for (const productId of productById.keys()) {
    const offersUrl =
      `${apiBase}/product/getOffers?ItemsPerPage=999&Page=1&ProductId=${productId}`;
    const offersRes = await adminFetch(offersUrl, {
      headers: {
        ...authHeaders(jar, bootstrapToken),
        Referer: `${apiBase}/product/edit/${productId}`,
      },
    });
    const offersText = await offersRes.text();
    let offersJson;
    try {
      offersJson = JSON.parse(offersText);
    } catch {
      log(`[sync] getOffers failed productId=${productId}: ${offersText.slice(0, 120)}`);
      continue;
    }
    const offers = offersJson?.DataItems || offersJson?.obj?.DataItems || [];
    offersByProduct.set(productId, offers);
    for (const offer of offers) {
      const offerArt = String(offer.ArtNo ?? "").trim();
      if (!offerArt) continue;
      offerByArt.set(offerArt.toLowerCase(), { productId, offer });
    }
  }
  log(`[sync] admin offers loaded: ${offerByArt.size}`);

  /** @type {Map<number, string>} */
  const tokenByProduct = new Map();
  async function tokenFor(productId) {
    if (!tokenByProduct.has(productId)) {
      tokenByProduct.set(
        productId,
        await fetchProductEditToken(apiBase, jar, productId),
      );
    }
    return tokenByProduct.get(productId);
  }

  async function postUpdateOffer(productId, offerPayload) {
    const token = await tokenFor(productId);
    const res = await adminFetch(`${apiBase}/product/updateOffer`, {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0",
        Cookie: cookieHeader(jar),
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json;charset=utf-8",
        __RequestVerificationToken: token,
        Referer: `${apiBase}/product/edit/${productId}`,
      },
      body: JSON.stringify(offerPayload),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(
        `updateOffer HTTP ${res.status} productId=${productId}: ${text.slice(0, 200)}`,
      );
    }
    if (json?.result === false || json?.Result === false) {
      const err = (json.errors || json.Errors || []).join("; ") || text.slice(0, 200);
      throw new Error(`updateOffer failed productId=${productId}: ${err}`);
    }
    return json;
  }

  /**
   * Если у товара есть хотя бы один оффер с цветом, AdvantShop требует Color
   * на каждом updateOffer («Укажите цвет»). Подставляем Color/ColorId
   * с соседнего оффера, не трогая Size.
   */
  function withRequiredColor(offer, productId) {
    const hasColorId =
      offer.ColorId != null && offer.ColorId !== 0 && offer.ColorId !== "";
    const hasColorName = String(offer.Color ?? "").trim() !== "";
    if (hasColorId || hasColorName) return offer;

    const siblings = offersByProduct.get(productId) || [];
    const donor =
      siblings.find(
        (o) =>
          o !== offer &&
          o.ColorId != null &&
          o.ColorId !== 0 &&
          o.ColorId !== "",
      ) ||
      siblings.find(
        (o) => o !== offer && String(o.Color ?? "").trim() !== "",
      );
    if (!donor) return offer;

    return {
      ...offer,
      ColorId: donor.ColorId,
      Color: donor.Color ?? offer.Color,
    };
  }

  const stocksByOffer = new Map();
  for (const row of rows) {
    const key = String(row.offer || row.artNo || "")
      .trim()
      .toLowerCase();
    if (!key) continue;
    stocksByOffer.set(key, row);
  }

  const updated = [];
  const notFound = [];
  const zeroed = [];
  const errors = [];
  /** @type {Map<string, { weight: string, set: string }>} */
  const productProps = new Map();

  for (const [offerKey, row] of stocksByOffer) {
    const found = offerByArt.get(offerKey);
    if (!found) {
      notFound.push(row.offer || row.artNo);
      continue;
    }

    const next = { ...found.offer };
    const amount = Number(String(row.amount ?? "").replace(",", "."));
    const price = Number(String(row.price ?? "").replace(",", "."));
    if (Number.isFinite(amount)) next.Amount = amount;
    if (Number.isFinite(price)) {
      next.BasePrice = price;
      if ("Price" in next) next.Price = price;
    }
    if (row.weight != null && String(row.weight).trim() !== "") {
      const weightNum = Number(String(row.weight).replace(",", "."));
      next.Weight = Number.isFinite(weightNum) ? weightNum : row.weight;
    }

    const parentArt = String(row.artNo || "").trim();
    if (parentArt) {
      productProps.set(parentArt.toLowerCase(), {
        weight: String(row.weight ?? "").trim(),
        set: String(row.set ?? "").trim(),
      });
    }

    const changed =
      Number(found.offer.Amount) !== Number(next.Amount) ||
      Number(found.offer.BasePrice) !== Number(next.BasePrice) ||
      String(found.offer.Weight ?? "") !== String(next.Weight ?? "");

    if (!changed) {
      updated.push(next.ArtNo);
      continue;
    }

    if (dryRun) {
      log(
        `[sync] dry-run updateOffer ${next.ArtNo}: amount ${found.offer.Amount}→${next.Amount}, price ${found.offer.BasePrice}→${next.BasePrice}, weight ${found.offer.Weight}→${next.Weight}`,
      );
      updated.push(next.ArtNo);
      continue;
    }

    try {
      await postUpdateOffer(
        found.productId,
        withRequiredColor(next, found.productId),
      );
      updated.push(next.ArtNo);
    } catch (error) {
      errors.push(`${next.ArtNo}: ${error?.message || error}`);
      log(`[sync] ERROR updateOffer ${next.ArtNo}: ${error?.message || error}`);
    }
  }

  if (zeroMissing) {
    for (const [offerKey, found] of offerByArt) {
      if (stocksByOffer.has(offerKey)) continue;
      const amountNow = Number(found.offer.Amount ?? 0);
      if (!Number.isFinite(amountNow) || amountNow === 0) continue;

      const next = withRequiredColor(
        { ...found.offer, Amount: 0 },
        found.productId,
      );
      if (dryRun) {
        log(`[sync] dry-run zero ${next.ArtNo}: amount ${amountNow}→0`);
        zeroed.push(next.ArtNo);
        continue;
      }
      try {
        await postUpdateOffer(found.productId, next);
        zeroed.push(next.ArtNo);
      } catch (error) {
        errors.push(`${next.ArtNo} zero: ${error?.message || error}`);
        log(`[sync] ERROR zero ${next.ArtNo}: ${error?.message || error}`);
      }
    }
  }

  // Set — свойство товара. Вес уже пишем в offer.Weight.
  // CSV для свойств без модификаций (только Артикул + Set).
  const setRows = [];
  for (const [artKey, props] of productProps) {
    if (!props.set) continue;
    const artNo =
      [...productIdByArt.entries()].find(([k]) => k === artKey)?.[0] || artKey;
    // restore original casing from stocks rows
    const sample = rows.find(
      (r) => String(r.artNo || "").trim().toLowerCase() === artKey,
    );
    setRows.push({
      artNo: sample?.artNo || artNo,
      set: props.set,
    });
  }

  log(
    `[sync] offers updated=${updated.length} zeroed=${zeroed.length} notFound=${notFound.length} errors=${errors.length}`,
  );
  if (notFound.length) {
    log(`[sync] not found in AdvantShop (${notFound.length}): ${notFound.join(", ")}`);
  }

  return {
    updatedArts: updated,
    zeroedArts: zeroed,
    notFoundArts: notFound,
    errorLines: errors,
    setRows,
    Update: updated.length,
    Add: 0,
    Error: errors.length,
  };
}

/**
 * CSV только для свойства Set (без модификаций/размеров/цены/остатка).
 */
export function buildSetPropertyCsv(setRows) {
  const out = ["Артикул;Свойство: Set"];
  for (const row of setRows) {
    out.push(`${escapeCsvSimple(row.artNo)};${escapeCsvSimple(row.set)}`);
  }
  return `${out.join("\r\n")}\r\n`;
}

function escapeCsvSimple(value) {
  const s = String(value ?? "");
  if (/[;"\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Читает текущие Размер/Цвет модификаций из админки AdvantShop.
 * @deprecated CSV с Size всё равно ломает карточку — используйте syncStocksViaAdminOffers.
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
  const catalogRes = await adminFetch(catalogUrl, {
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
    const offersRes = await adminFetch(offersUrl, {
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
